import { useEffect, useMemo, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRevalidator,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CLASS_TIMEZONE } from "../lib/class-config";
import { allocateClassSessionSkus } from "../lib/class-skus.server";
import { formatSessionTitle, parseSessionSku } from "../lib/sku";
import { parseSessionTitle } from "../lib/parse-session-title";
import {
  ensureSessionDateOption,
  getProduct,
} from "../.server/shopify/products";
import {
  createSessionVariants,
  deleteVariants,
  setInventoryAtLocation,
  updateSessionVariant,
  updateVariantSkus,
  type SessionDraft,
} from "../.server/shopify/variants";
import {
  getShopCurrency,
  listShopifyLocations,
} from "../.server/shopify/locations";

type ShopifyVariantImportCandidate = {
  variantGid: string;
  inventoryItemGid: string | null;
  sku: string | null;
  title: string;
  date: string;
  time: string;
  capacity: number;
};

type ImportSessionInput = {
  variantGid?: string;
  inventoryItemGid?: string | null;
  sku?: string | null;
  startsAt?: string;
  capacity?: number;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  const id = String(params.id);

  const [classProduct, locations, shopifyLocations] = await Promise.all([
    db.classProduct.findFirst({
      where: { id, shop: session.shop },
      include: {
        location: true,
        sessions: { orderBy: { startsAt: "asc" } },
      },
    }),
    db.location.findMany({
      where: { shop: session.shop, archived: false },
      orderBy: { name: "asc" },
    }),
    listShopifyLocations(admin),
  ]);

  if (!classProduct) throw new Response("Not found", { status: 404 });

  const product = await getProduct(admin, classProduct.productGid);
  const importCandidates = product
    ? buildImportCandidates(
        product.variants,
        classProduct.sessions,
        classProduct.defaultCapacity,
      )
    : [];

  return { classProduct, locations, shopifyLocations, importCandidates };
};

type ActionData = { error: string } | { ok: true; message: string };

export const action = async ({
  request,
  params,
}: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const id = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  const classProduct = await db.classProduct.findFirst({
    where: { id, shop: session.shop },
  });
  if (!classProduct) throw new Response("Not found", { status: 404 });

  if (intent === "save-class") {
    const title = String(form.get("title") ?? classProduct.title).trim();
    if (!title) return { error: "Enter an event name to continue." };

    const locationId = String(form.get("locationId") ?? "") || null;
    const durationMin = Number(
      form.get("durationMin") ?? classProduct.durationMin,
    );
    const defaultCapacity = Number(
      form.get("defaultCapacity") ?? classProduct.defaultCapacity,
    );
    let parsed: ImportSessionInput[];
    try {
      parsed = JSON.parse(String(form.get("sessions") ?? "[]"));
    } catch {
      return { error: "Couldn't read Shopify variants." };
    }
    if (!Array.isArray(parsed)) {
      return { error: "Couldn't read Shopify variants." };
    }

    let rows: Array<{
      classProductId: string;
      shop: string;
      variantGid: string;
      inventoryItemGid: string | null;
      sku: string;
      startsAt: Date;
      endsAt: Date;
      timezone: string;
      capacity: number;
      priceCents: null;
    }> = [];
    let invalidSessionTime = false;

    if (parsed.length > 0) {
      const product = await getProduct(admin, classProduct.productGid);
      if (!product) return { error: "Shopify product not found." };

      const productVariants = new Map(product.variants.map((v) => [v.id, v]));
      const existingSessions = await db.classSession.findMany({
        where: { classProductId: classProduct.id },
        select: { variantGid: true },
      });
      const existingVariantIds = new Set(
        existingSessions.map((s) => s.variantGid),
      );

      const incomingRows = parsed
        .map((input) => {
          if (!input.variantGid) return null;
          if (!input.startsAt) {
            invalidSessionTime = true;
            return null;
          }
          if (existingVariantIds.has(input.variantGid)) return null;

          const variant = productVariants.get(input.variantGid);
          if (!variant) return null;

          const startsAt = DateTime.fromISO(input.startsAt, {
            zone: CLASS_TIMEZONE,
          });
          if (!startsAt.isValid) {
            invalidSessionTime = true;
            return null;
          }

          const capacity = Number(input.capacity ?? defaultCapacity);
          return {
            classProductId: classProduct.id,
            shop: session.shop,
            variantGid: variant.id,
            inventoryItemGid:
              variant.inventoryItemId ?? input.inventoryItemGid ?? null,
            startsAt: startsAt.toJSDate(),
            endsAt: startsAt.plus({ minutes: durationMin }).toJSDate(),
            timezone: CLASS_TIMEZONE,
            capacity: Number.isFinite(capacity) ? capacity : defaultCapacity,
            priceCents: null,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row !== null);

      const skus = await allocateClassSessionSkus(
        db,
        session.shop,
        incomingRows.length,
      );

      rows = incomingRows.map((row, index) => ({
        ...row,
        sku: skus[index],
      }));

      try {
        await updateVariantSkus(admin, {
          productGid: classProduct.productGid,
          variants: rows.map((row) => ({
            variantId: row.variantGid,
            sku: row.sku,
          })),
        });
      } catch (error) {
        return { error: shopifyMutationError(error) };
      }
    }

    if (invalidSessionTime) {
      return { error: "Enter a valid date and 24-hour time (e.g. 09:30)." };
    }

    await db.$transaction(async (tx) => {
      await tx.classProduct.update({
        where: { id },
        data: {
          title,
          locationId,
          timezone: CLASS_TIMEZONE,
          durationMin,
          defaultCapacity,
          defaultPriceCents: null,
        },
      });

      if (rows.length > 0) {
        await tx.classSession.createMany({
          data: rows,
          skipDuplicates: true,
        });
      }
    });

    if (rows.length === 0) return { ok: true, message: "Saved." };

    return {
      ok: true,
      message: `Saved and added ${rows.length} new session${rows.length === 1 ? "" : "s"}.`,
    };
  }

  if (intent === "add-sessions") {
    const shopifyLocationGid = String(form.get("shopifyLocationGid") ?? "");
    if (!shopifyLocationGid)
      return { error: "No Shopify inventory location is available." };
    let parsed: Array<{ startsAt: string; capacity?: number }>;
    try {
      parsed = JSON.parse(String(form.get("sessions") ?? "[]"));
    } catch {
      return { error: "Couldn't read sessions." };
    }
    if (!Array.isArray(parsed) || parsed.length === 0)
      return { error: "Add at least one session." };

    const skus = await allocateClassSessionSkus(
      db,
      session.shop,
      parsed.length,
    );
    let skuIndex = 0;
    const drafts: SessionDraft[] = parsed.map((s) => {
      const startsAt = DateTime.fromISO(s.startsAt, { zone: CLASS_TIMEZONE });
      const endsAt = startsAt.plus({ minutes: classProduct.durationMin });
      return {
        startsAt: startsAt.toJSDate(),
        endsAt: endsAt.toJSDate(),
        timezone: CLASS_TIMEZONE,
        capacity: s.capacity ?? classProduct.defaultCapacity,
        sku: skus[skuIndex++],
        displayName: formatSessionTitle(startsAt.toISO()!, CLASS_TIMEZONE),
      };
    });

    if (drafts.some((d) => Number.isNaN(d.startsAt.getTime()))) {
      return {
        error:
          "One or more sessions has an invalid time. Use 24-hour HH:MM (e.g. 09:30).",
      };
    }

    let created: Awaited<ReturnType<typeof createSessionVariants>>;
    try {
      const option = await ensureSessionDateOption(
        admin,
        classProduct.productGid,
      );
      if (!option)
        return { error: "Couldn't prepare the product date option." };
      const currencyCode = await getShopCurrency(admin);
      created = await createSessionVariants(admin, {
        productGid: classProduct.productGid,
        drafts,
        currencyCode,
        option,
      });
    } catch (error) {
      return { error: shopifyMutationError(error) };
    }

    await Promise.all(
      created
        .map((c, idx) =>
          c.inventoryItemGid
            ? setInventoryAtLocation(admin, {
                inventoryItemGid: c.inventoryItemGid,
                locationGid: shopifyLocationGid,
                quantity: drafts[idx].capacity,
              })
            : null,
        )
        .filter((p): p is Promise<void> => p !== null),
    );

    await db.classSession.createMany({
      data: created.map((c, idx) => ({
        classProductId: classProduct.id,
        shop: session.shop,
        variantGid: c.variantGid,
        inventoryItemGid: c.inventoryItemGid,
        sku: c.sku,
        startsAt: drafts[idx].startsAt,
        endsAt: drafts[idx].endsAt,
        timezone: CLASS_TIMEZONE,
        capacity: drafts[idx].capacity,
        priceCents: null,
      })),
      skipDuplicates: true,
    });

    return {
      ok: true,
      message: `Added ${created.length} session${created.length === 1 ? "" : "s"}.`,
    };
  }

  if (intent === "remove-session") {
    const sessionId = String(form.get("sessionId") ?? "");
    const target = await db.classSession.findFirst({
      where: { id: sessionId, classProductId: classProduct.id },
    });
    if (!target) return { error: "Session not found." };
    await deleteVariants(admin, {
      productGid: classProduct.productGid,
      variantIds: [target.variantGid],
    });
    await db.classSession.delete({ where: { id: target.id } });
    return { ok: true, message: "Session removed." };
  }

  if (intent === "edit-session") {
    const sessionId = String(form.get("sessionId") ?? "");
    const date = String(form.get("date") ?? "");
    const time = String(form.get("time") ?? "");
    const target = await db.classSession.findFirst({
      where: { id: sessionId, classProductId: classProduct.id },
    });
    if (!target) return { error: "Session not found." };

    const startsAt = DateTime.fromISO(`${date}T${time}`, {
      zone: CLASS_TIMEZONE,
    });
    if (!startsAt.isValid) {
      return { error: "Enter a valid date and 24-hour time (e.g. 09:30)." };
    }
    const endsAt = startsAt.plus({ minutes: classProduct.durationMin });
    const startsAtIso = startsAt.toISO()!;
    const sku =
      target.sku || (await allocateClassSessionSkus(db, session.shop, 1))[0];
    const displayName = formatSessionTitle(startsAtIso, CLASS_TIMEZONE);

    // Update Shopify first; if it fails (e.g. duplicate date) we surface the
    // error and leave the local row untouched.
    try {
      const option = await ensureSessionDateOption(
        admin,
        classProduct.productGid,
      );
      if (!option)
        return { error: "Couldn't prepare the product date option." };

      await updateSessionVariant(admin, {
        productGid: classProduct.productGid,
        variantId: target.variantGid,
        displayName,
        sku,
        option,
      });
    } catch (error) {
      return { error: shopifyMutationError(error) };
    }

    await db.classSession.update({
      where: { id: target.id },
      data: { startsAt: startsAt.toJSDate(), endsAt: endsAt.toJSDate(), sku },
    });

    return { ok: true, message: "Session updated." };
  }

  if (intent === "delete-class") {
    await db.classProduct.delete({ where: { id: classProduct.id } });
    return redirect("/app/classes");
  }

  return { error: "Unknown action." };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function ClassDetail() {
  const { classProduct, locations, shopifyLocations, importCandidates } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const saveFormId = "class-save-form";
  const deleteFormId = "class-delete-form";
  const [title, setTitle] = useState(classProduct.title);
  const [locationId, setLocationId] = useState(classProduct.locationId ?? "");
  const [durationMin, setDurationMin] = useState(
    String(classProduct.durationMin),
  );
  const [defaultCapacity, setDefaultCapacity] = useState(
    String(classProduct.defaultCapacity),
  );
  const [importRows, setImportRows] =
    useState<ShopifyVariantImportCandidate[]>(importCandidates);
  const [refreshStatus, setRefreshStatus] = useState<"idle" | "waiting">(
    "idle",
  );
  const [refreshHasLoaded, setRefreshHasLoaded] = useState(false);
  const [showNoNewClasses, setShowNoNewClasses] = useState(false);
  const defaultCapacityNumber = Number(defaultCapacity);
  const importPayload = useMemo(
    () =>
      importRows.map((row) => ({
        variantGid: row.variantGid,
        inventoryItemGid: row.inventoryItemGid,
        sku: row.sku,
        startsAt: DateTime.fromISO(`${row.date}T${row.time}`, {
          zone: CLASS_TIMEZONE,
        }).toISO(),
        capacity: Number.isFinite(row.capacity)
          ? row.capacity
          : defaultCapacityNumber,
      })),
    [defaultCapacityNumber, importRows],
  );

  useEffect(() => {
    setTitle(classProduct.title);
    setLocationId(classProduct.locationId ?? "");
    setDurationMin(String(classProduct.durationMin));
    setDefaultCapacity(String(classProduct.defaultCapacity));
  }, [
    classProduct.defaultCapacity,
    classProduct.durationMin,
    classProduct.id,
    classProduct.locationId,
    classProduct.title,
  ]);

  useEffect(() => {
    setImportRows(importCandidates);
  }, [importCandidates]);

  function refreshClass() {
    setRefreshStatus("waiting");
    setRefreshHasLoaded(false);
    setShowNoNewClasses(false);
    revalidator.revalidate();
  }

  useEffect(() => {
    if (refreshStatus !== "waiting") return;

    if (revalidator.state !== "idle") {
      setRefreshHasLoaded(true);
      return;
    }

    if (!refreshHasLoaded) return;

    setShowNoNewClasses(importCandidates.length === 0);
    setRefreshStatus("idle");
  }, [
    importCandidates.length,
    refreshHasLoaded,
    refreshStatus,
    revalidator.state,
  ]);

  useEffect(() => {
    if (importCandidates.length > 0) setShowNoNewClasses(false);
  }, [importCandidates.length]);

  function submitFormById(formId: string) {
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  function saveClass() {
    setShowNoNewClasses(false);
    submitFormById(saveFormId);
  }

  return (
    <s-page heading={title || classProduct.title}>
      <s-link slot="breadcrumb-actions" href="/app/classes">
        Events
      </s-link>

      <s-button
        slot="primary-action"
        variant="primary"
        type="button"
        loading={busy ? true : undefined}
        onClick={saveClass}
      >
        Save
      </s-button>
      <s-button slot="secondary-actions" commandFor="class-actions-menu">
        More actions
      </s-button>

      <s-menu id="class-actions-menu" accessibilityLabel="Class actions">
        <s-button
          icon="product"
          href={`shopify://admin/products/${productNumericId(classProduct.productGid)}`}
          target="_top"
        >
          Open product
        </s-button>
        <s-button icon="refresh" onClick={refreshClass}>
          Refresh
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor="delete-class-modal"
          command="--show"
        >
          Delete
        </s-button>
      </s-menu>

      {actionData && "ok" in actionData && (
        <s-banner tone="success">{actionData.message}</s-banner>
      )}
      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}
      {showNoNewClasses && (
        <s-banner heading="No new classes found" tone="warning" />
      )}

      <SessionsCard classProduct={classProduct} busy={busy} />
      <ShopifyVariantImportCard rows={importRows} setRows={setImportRows} />
      <AddSessionsCard shopifyLocations={shopifyLocations} busy={busy} />

      <DefaultsCard
        title={title}
        setTitle={setTitle}
        locations={locations}
        locationId={locationId}
        setLocationId={setLocationId}
        durationMin={durationMin}
        setDurationMin={setDurationMin}
        defaultCapacity={defaultCapacity}
        setDefaultCapacity={setDefaultCapacity}
      />

      <Form id={saveFormId} method="post">
        <input type="hidden" name="intent" value="save-class" />
        <input type="hidden" name="title" value={title} />
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="durationMin" value={durationMin} />
        <input type="hidden" name="defaultCapacity" value={defaultCapacity} />
        <input
          type="hidden"
          name="sessions"
          value={JSON.stringify(importPayload)}
        />
      </Form>

      <Form id={deleteFormId} method="post">
        <input type="hidden" name="intent" value="delete-class" />
      </Form>

      <s-modal id="delete-class-modal" heading="Delete event?">
        <s-stack gap="base">
          <s-text>
            This removes the event from Classes. The Shopify product will not be
            deleted.
          </s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-class-modal"
          command="--hide"
          onClick={() => submitFormById(deleteFormId)}
        >
          Delete event
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="delete-class-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}

type ClassProductWith = Awaited<ReturnType<typeof loader>>["classProduct"];

function DefaultsCard({
  title,
  setTitle,
  locations,
  locationId,
  setLocationId,
  durationMin,
  setDurationMin,
  defaultCapacity,
  setDefaultCapacity,
}: {
  title: string;
  setTitle: (value: string) => void;
  locations: { id: string; name: string }[];
  locationId: string;
  setLocationId: (value: string) => void;
  durationMin: string;
  setDurationMin: (value: string) => void;
  defaultCapacity: string;
  setDefaultCapacity: (value: string) => void;
}) {
  return (
    <s-section slot="aside" heading="Event defaults">
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Internal event name"
          value={title}
          required
          onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
        <s-select
          label="Display location"
          value={locationId}
          onChange={(e) => setLocationId((e.target as HTMLSelectElement).value)}
        >
          <s-option value="">None</s-option>
          {locations.map((l) => (
            <s-option key={l.id} value={l.id}>
              {l.name}
            </s-option>
          ))}
        </s-select>
        <s-grid gridTemplateColumns="1fr 1fr" gap="base">
          <s-number-field
            label="Duration (min)"
            value={durationMin}
            onChange={(e) =>
              setDurationMin((e.target as HTMLInputElement).value)
            }
          />
          <s-number-field
            label="Capacity (seats)"
            value={defaultCapacity}
            onChange={(e) =>
              setDefaultCapacity((e.target as HTMLInputElement).value)
            }
          />
        </s-grid>
        <s-paragraph>Class price comes from the Shopify product.</s-paragraph>
      </s-stack>
    </s-section>
  );
}

function SessionsCard({
  classProduct,
  busy,
}: {
  classProduct: ClassProductWith;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const now = new Date();
  const sessions = [...classProduct.sessions].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const rows = sessions.map((session) => {
    const iso =
      typeof session.startsAt === "string"
        ? session.startsAt
        : session.startsAt.toISOString();
    const title = formatSessionTitle(iso, CLASS_TIMEZONE);
    const editDt = DateTime.fromISO(iso, { zone: CLASS_TIMEZONE });
    const upcoming = !session.cancelled && new Date(iso) > now;
    const status = session.cancelled
      ? "Cancelled"
      : upcoming
        ? "Upcoming"
        : "Past";

    return {
      session,
      title,
      status,
      upcoming,
      editDate: editDt.toFormat("yyyy-LL-dd"),
      editTime: editDt.toFormat("HH:mm"),
    };
  });
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = normalizedQuery
    ? rows.filter(({ session, status, title }) =>
        [title, status, String(session.capacity), session.sku]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : rows;

  return (
    <s-section
      accessibilityLabel="Sessions"
      padding={sessions.length === 0 ? "base" : "none"}
    >
      {sessions.length === 0 ? (
        <s-text tone="neutral">No sessions yet. Add dates below.</s-text>
      ) : (
        <s-table>
          <s-search-field
            slot="filters"
            label="Search sessions"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search sessions"
            value={query}
            onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
          />
          <s-table-header-row>
            <s-table-header listSlot="primary">Date</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header format="numeric" listSlot="labeled">
              Seats
            </s-table-header>
            <s-table-header listSlot="labeled">SKU</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {visibleRows.map(
              ({ session, title, status, upcoming, editDate, editTime }) => {
                return (
                  <s-table-row key={session.id}>
                    <s-table-cell>{title}</s-table-cell>
                    <s-table-cell>
                      {status === "Cancelled" ? (
                        <s-badge tone="critical">Cancelled</s-badge>
                      ) : upcoming ? (
                        <s-badge tone="success">Upcoming</s-badge>
                      ) : (
                        <s-badge>Past</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>{session.capacity}</s-table-cell>
                    <s-table-cell>{session.sku}</s-table-cell>
                    <s-table-cell>
                      <s-stack direction="inline" gap="small-200">
                        <EditSessionPopover
                          sessionId={session.id}
                          title={title}
                          defaultDate={editDate}
                          defaultTime={editTime}
                          busy={busy}
                        />
                        <Form method="post">
                          <input
                            type="hidden"
                            name="intent"
                            value="remove-session"
                          />
                          <input
                            type="hidden"
                            name="sessionId"
                            value={session.id}
                          />
                          <s-button
                            type="submit"
                            tone="critical"
                            variant="tertiary"
                            icon="delete"
                            accessibilityLabel={`Remove ${title}`}
                          />
                        </Form>
                      </s-stack>
                    </s-table-cell>
                  </s-table-row>
                );
              },
            )}
          </s-table-body>
        </s-table>
      )}
    </s-section>
  );
}

function ShopifyVariantImportCard({
  rows,
  setRows,
}: {
  rows: ShopifyVariantImportCandidate[];
  setRows: (
    updater: (
      rows: ShopifyVariantImportCandidate[],
    ) => ShopifyVariantImportCandidate[],
  ) => void;
}) {
  if (rows.length === 0) return null;

  return (
    <s-section heading={`New Shopify variants (${rows.length})`} padding="none">
      <s-table>
        <s-table-header-row>
          <s-table-header listSlot="primary">Variant</s-table-header>
          <s-table-header listSlot="labeled">Date</s-table-header>
          <s-table-header listSlot="labeled">Start time (24h)</s-table-header>
          <s-table-header format="numeric" listSlot="labeled">
            Seats
          </s-table-header>
          <s-table-header listSlot="labeled">SKU</s-table-header>
        </s-table-header-row>
        <s-table-body>
          {rows.map((row) => (
            <s-table-row key={row.variantGid}>
              <s-table-cell>{row.title}</s-table-cell>
              <s-table-cell>
                <s-date-field
                  label="Date"
                  labelAccessibilityVisibility="exclusive"
                  value={row.date}
                  onChange={(e) =>
                    setRows((current) =>
                      current.map((r) =>
                        r.variantGid === row.variantGid
                          ? { ...r, date: (e.target as HTMLInputElement).value }
                          : r,
                      ),
                    )
                  }
                />
              </s-table-cell>
              <s-table-cell>
                <s-text-field
                  label="Start time (24h)"
                  labelAccessibilityVisibility="exclusive"
                  placeholder="15:00"
                  value={row.time}
                  onChange={(e) =>
                    setRows((current) =>
                      current.map((r) =>
                        r.variantGid === row.variantGid
                          ? { ...r, time: (e.target as HTMLInputElement).value }
                          : r,
                      ),
                    )
                  }
                />
              </s-table-cell>
              <s-table-cell>{row.capacity}</s-table-cell>
              <s-table-cell>{row.sku ?? ""}</s-table-cell>
            </s-table-row>
          ))}
        </s-table-body>
      </s-table>
    </s-section>
  );
}

function AddSessionsCard({
  shopifyLocations,
  busy,
}: {
  shopifyLocations: { id: string; name: string }[];
  busy: boolean;
}) {
  const [draftRows, setDraftRows] = useState<{ date: string; time: string }[]>([
    {
      date: DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd"),
      time: "15:00",
    },
  ]);
  const shopifyLocationGid = shopifyLocations[0]?.id ?? "";

  const payload = useMemo(
    () =>
      draftRows
        .filter((r) => r.date && r.time)
        .map((r) => ({
          startsAt: DateTime.fromISO(`${r.date}T${r.time}`, {
            zone: CLASS_TIMEZONE,
          }).toISO(),
        })),
    [draftRows],
  );

  return (
    <s-section heading="Add sessions">
      <s-stack direction="block" gap="base">
        {draftRows.map((row, idx) => (
          <s-grid
            key={idx}
            gridTemplateColumns="minmax(0, 1fr) minmax(0, 1fr) auto"
            gap="base"
            alignItems="end"
          >
            <s-date-field
              label={idx === 0 ? "Date" : undefined}
              value={row.date}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) =>
                    i === idx
                      ? { ...r, date: (e.target as HTMLInputElement).value }
                      : r,
                  ),
                )
              }
            />
            <s-text-field
              label={idx === 0 ? "Start time (24h)" : undefined}
              placeholder="15:00"
              value={row.time}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) =>
                    i === idx
                      ? { ...r, time: (e.target as HTMLInputElement).value }
                      : r,
                  ),
                )
              }
            />
            <s-button-group accessibilityLabel="Session row actions">
              <s-button
                slot="secondary-actions"
                tone="critical"
                onClick={() =>
                  setDraftRows((rs) => rs.filter((_, i) => i !== idx))
                }
                disabled={draftRows.length === 1}
              >
                Delete
              </s-button>
            </s-button-group>
          </s-grid>
        ))}

        <Form method="post">
          <input type="hidden" name="intent" value="add-sessions" />
          <input
            type="hidden"
            name="shopifyLocationGid"
            value={shopifyLocationGid}
          />
          <input
            type="hidden"
            name="sessions"
            value={JSON.stringify(payload)}
          />
          <s-button-group accessibilityLabel="Session actions">
            <s-button
              slot="secondary-actions"
              type="button"
              onClick={() =>
                setDraftRows((rs) => [
                  ...rs,
                  {
                    date: rs[rs.length - 1]?.date ?? "",
                    time: rs[rs.length - 1]?.time ?? "15:00",
                  },
                ])
              }
            >
              Add row
            </s-button>
            <s-button
              slot="primary-action"
              type="submit"
              variant="primary"
              loading={busy ? true : undefined}
            >
              Generate variants
            </s-button>
          </s-button-group>
        </Form>
      </s-stack>
    </s-section>
  );
}

// Per-row edit control: an icon button that toggles a popover with date + time
// fields. Submitting posts the `edit-session` intent, which re-dates the Shopify
// variant and the local session. Date/time are held in state and mirrored into
// hidden inputs so submission doesn't depend on web-component form wiring.
function EditSessionPopover({
  sessionId,
  title,
  defaultDate,
  defaultTime,
  busy,
}: {
  sessionId: string;
  title: string;
  defaultDate: string;
  defaultTime: string;
  busy: boolean;
}) {
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);

  return (
    <>
      <s-button
        variant="tertiary"
        icon="edit"
        command="--toggle"
        commandFor={`edit-${sessionId}`}
        accessibilityLabel={`Edit ${title}`}
      />
      <s-popover id={`edit-${sessionId}`} minInlineSize="260px">
        <s-box padding="base">
          <Form method="post">
            <input type="hidden" name="intent" value="edit-session" />
            <input type="hidden" name="sessionId" value={sessionId} />
            <input type="hidden" name="date" value={date} />
            <input type="hidden" name="time" value={time} />
            <s-stack direction="block" gap="base">
              <s-date-field
                label="Date"
                value={date}
                onChange={(e) => setDate((e.target as HTMLInputElement).value)}
              />
              <s-text-field
                label="Start time (24h)"
                placeholder="15:00"
                details="24-hour, e.g. 09:30"
                value={time}
                onChange={(e) => setTime((e.target as HTMLInputElement).value)}
              />
              <s-button
                type="submit"
                variant="primary"
                loading={busy ? true : undefined}
              >
                Save
              </s-button>
            </s-stack>
          </Form>
        </s-box>
      </s-popover>
    </>
  );
}

function buildImportCandidates(
  variants: NonNullable<Awaited<ReturnType<typeof getProduct>>>["variants"],
  sessions: { variantGid: string }[],
  defaultCapacity: number,
): ShopifyVariantImportCandidate[] {
  const existingVariantIds = new Set(sessions.map((s) => s.variantGid));
  const now = DateTime.now().setZone(CLASS_TIMEZONE);

  return variants
    .map((variant) => {
      if (existingVariantIds.has(variant.id)) return null;

      const skuDateTime = parseSessionSku(variant.sku, CLASS_TIMEZONE);
      const titleDateTime = skuDateTime
        ? null
        : parseSessionTitle(variant.title, now);
      const date = skuDateTime?.date ?? titleDateTime?.date;
      if (!date) return null;

      return {
        variantGid: variant.id,
        inventoryItemGid: variant.inventoryItemId,
        sku: variant.sku,
        title: variant.title,
        date,
        time: skuDateTime?.time ?? titleDateTime?.time ?? "15:00",
        capacity: variant.inventoryQuantity ?? defaultCapacity,
      };
    })
    .filter(
      (candidate): candidate is ShopifyVariantImportCandidate =>
        candidate !== null,
    )
    .sort((a, b) => {
      const aStartsAt = DateTime.fromISO(`${a.date}T${a.time}`, {
        zone: CLASS_TIMEZONE,
      });
      const bStartsAt = DateTime.fromISO(`${b.date}T${b.time}`, {
        zone: CLASS_TIMEZONE,
      });
      return aStartsAt.toMillis() - bStartsAt.toMillis();
    });
}

function productNumericId(gid: string): string {
  return gid.split("/").pop() ?? "";
}

function shopifyMutationError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Couldn't update the Shopify product.";
}
