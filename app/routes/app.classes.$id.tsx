import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
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
import { SaveBar } from "@shopify/app-bridge-react";
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
import styles from "../class-detail.module.css";

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

type NewSessionInput = {
  startsAt?: string | null;
  capacity?: number;
};

type NewSessionDraftRow = {
  date: string;
  time: string;
};

type SessionSortField = "date" | "status" | "seats";
type ClassActivityTone = "base" | "success" | "critical" | "caution";
type ClassActivityIcon = "calendar" | "edit" | "product";
type ClassActivityItem = {
  message: string;
  timestamp: DateTime;
  tone?: ClassActivityTone;
  icon?: ClassActivityIcon;
};

const SESSION_SORT_OPTIONS: Array<{
  field: SessionSortField;
  label: string;
}> = [
  { field: "date", label: "Date" },
  { field: "status", label: "Status" },
  { field: "seats", label: "Seats" },
];

const SESSION_TIME_OPTIONS = Array.from({ length: 27 }, (_, index) => {
  const totalMinutes = 8 * 60 + index * 30;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}`;
  const labelHour = hour % 12 || 12;
  const meridiem = hour < 12 ? "AM" : "PM";

  return {
    value,
    label: `${labelHour}:${String(minute).padStart(2, "0")} ${meridiem}`,
  };
});

type StatusBadgeTone = "success" | "info" | "critical";

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
  const variantTitleById = Object.fromEntries(
    (product?.variants ?? []).map((variant) => [variant.id, variant.title]),
  );
  const importCandidates = product
    ? buildImportCandidates(
        product.variants,
        classProduct.sessions,
        classProduct.defaultCapacity,
      )
    : [];

  return {
    classProduct,
    locations,
    shopifyLocations,
    importCandidates,
    variantTitleById,
  };
};

type ActionData =
  | { error: string }
  | {
      ok: true;
      intent: "save-class" | "remove-session" | "edit-session";
      message: string;
    };

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
    let parsedNewSessions: NewSessionInput[];
    try {
      parsedNewSessions = JSON.parse(String(form.get("newSessions") ?? "[]"));
    } catch {
      return { error: "Couldn't read new sessions." };
    }
    if (!Array.isArray(parsedNewSessions)) {
      return { error: "Couldn't read new sessions." };
    }
    const shopifyLocationGid = String(form.get("shopifyLocationGid") ?? "");
    if (parsedNewSessions.length > 0 && !shopifyLocationGid) {
      return { error: "No Shopify inventory location is available." };
    }

    let linkedRows: Array<{
      classProductId: string;
      shop: string;
      variantGid: string;
      inventoryItemGid: string | null;
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

      linkedRows = parsed
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
    }

    const newSessionInputs = parsedNewSessions
      .map((input) => {
        if (!input.startsAt) {
          invalidSessionTime = true;
          return null;
        }

        const startsAt = DateTime.fromISO(input.startsAt, {
          zone: CLASS_TIMEZONE,
        });
        if (!startsAt.isValid) {
          invalidSessionTime = true;
          return null;
        }

        const capacity = Number(input.capacity ?? defaultCapacity);
        return {
          startsAt,
          capacity: Number.isFinite(capacity) ? capacity : defaultCapacity,
        };
      })
      .filter((row): row is NonNullable<typeof row> => row !== null);

    if (invalidSessionTime) {
      return { error: "Enter a valid date and 24-hour time (e.g. 09:30)." };
    }

    const skus = await allocateClassSessionSkus(
      db,
      session.shop,
      linkedRows.length + newSessionInputs.length,
    );
    let skuIndex = 0;
    const linkedRowsWithSkus = linkedRows.map((row) => ({
      ...row,
      sku: skus[skuIndex++],
    }));
    const newSessionDrafts: SessionDraft[] = newSessionInputs.map((input) => {
      const startsAtIso = input.startsAt.toISO()!;
      return {
        startsAt: input.startsAt.toJSDate(),
        endsAt: input.startsAt.plus({ minutes: durationMin }).toJSDate(),
        timezone: CLASS_TIMEZONE,
        capacity: input.capacity,
        sku: skus[skuIndex++],
        displayName: formatSessionTitle(startsAtIso, CLASS_TIMEZONE),
      };
    });

    let createdRows: Array<{
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

    if (newSessionDrafts.length > 0) {
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
          drafts: newSessionDrafts,
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
                  quantity: newSessionDrafts[idx].capacity,
                })
              : null,
          )
          .filter((p): p is Promise<void> => p !== null),
      );

      createdRows = created.map((c, idx) => ({
        classProductId: classProduct.id,
        shop: session.shop,
        variantGid: c.variantGid,
        inventoryItemGid: c.inventoryItemGid,
        sku: c.sku,
        startsAt: newSessionDrafts[idx].startsAt,
        endsAt: newSessionDrafts[idx].endsAt,
        timezone: CLASS_TIMEZONE,
        capacity: newSessionDrafts[idx].capacity,
        priceCents: null,
      }));
    }

    if (linkedRowsWithSkus.length > 0) {
      try {
        await updateVariantSkus(admin, {
          productGid: classProduct.productGid,
          variants: linkedRowsWithSkus.map((row) => ({
            variantId: row.variantGid,
            sku: row.sku,
          })),
        });
      } catch (error) {
        return { error: shopifyMutationError(error) };
      }
    }

    const rows = [...linkedRowsWithSkus, ...createdRows];

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

    if (rows.length === 0)
      return { ok: true, intent: "save-class", message: "Saved." };

    return {
      ok: true,
      intent: "save-class",
      message: `Saved and added ${rows.length} new session${rows.length === 1 ? "" : "s"}.`,
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
    return { ok: true, intent: "remove-session", message: "Session removed." };
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

    return { ok: true, intent: "edit-session", message: "Session updated." };
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
  const {
    classProduct,
    locations,
    shopifyLocations,
    importCandidates,
    variantTitleById,
  } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const revalidator = useRevalidator();
  const busy = navigation.state !== "idle" || revalidator.state !== "idle";
  const saveBarId = "class-save-bar";
  const saveFormId = "class-save-form";
  const deleteFormId = "class-delete-form";
  const shopifyLocationGid = shopifyLocations[0]?.id ?? "";
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
  const [newSessionBaselineRows, setNewSessionBaselineRows] = useState<
    NewSessionDraftRow[]
  >(() => buildDefaultNewSessionRows());
  const [newSessionRows, setNewSessionRows] = useState<NewSessionDraftRow[]>(
    () => buildDefaultNewSessionRows(),
  );
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
  const baselineImportPayload = useMemo(
    () =>
      importCandidates.map((row) => ({
        variantGid: row.variantGid,
        inventoryItemGid: row.inventoryItemGid,
        sku: row.sku,
        startsAt: DateTime.fromISO(`${row.date}T${row.time}`, {
          zone: CLASS_TIMEZONE,
        }).toISO(),
        capacity: Number.isFinite(row.capacity)
          ? row.capacity
          : classProduct.defaultCapacity,
      })),
    [classProduct.defaultCapacity, importCandidates],
  );
  const activityItems = useMemo(
    () => buildClassActivityItems(classProduct, variantTitleById),
    [classProduct, variantTitleById],
  );
  const newSessionRowsDirty =
    JSON.stringify(newSessionRows) !== JSON.stringify(newSessionBaselineRows);
  const newSessionPayload = useMemo(
    () =>
      newSessionRowsDirty ? buildNewSessionPayload(newSessionRows) : [],
    [newSessionRows, newSessionRowsDirty],
  );
  const isDirty =
    title !== classProduct.title ||
    locationId !== (classProduct.locationId ?? "") ||
    durationMin !== String(classProduct.durationMin) ||
    defaultCapacity !== String(classProduct.defaultCapacity) ||
    JSON.stringify(importPayload) !== JSON.stringify(baselineImportPayload) ||
    newSessionRowsDirty;

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

  useEffect(() => {
    const rows = buildDefaultNewSessionRows();
    setNewSessionBaselineRows(rows);
    setNewSessionRows(rows);
  }, [classProduct.id]);

  useEffect(() => {
    if (!(actionData && "ok" in actionData)) return;
    if (actionData.intent !== "save-class") return;

    const rows = buildDefaultNewSessionRows();
    setNewSessionBaselineRows(rows);
    setNewSessionRows(rows);
  }, [actionData]);

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

  function discardChanges() {
    setTitle(classProduct.title);
    setLocationId(classProduct.locationId ?? "");
    setDurationMin(String(classProduct.durationMin));
    setDefaultCapacity(String(classProduct.defaultCapacity));
    setImportRows(importCandidates);
    setNewSessionRows(newSessionBaselineRows);
    setShowNoNewClasses(false);
  }

  return (
    <s-page heading={title || classProduct.title}>
      <s-link slot="breadcrumb-actions" href="/app/classes">
        Events
      </s-link>

      <SaveBar id={saveBarId} open={isDirty}>
        <button
          type="button"
          disabled={busy}
          onClick={saveClass}
          {...({ variant: "primary" } as Record<string, string>)}
        >
          Save
        </button>
        <button type="button" disabled={busy} onClick={discardChanges}>
          Discard
        </button>
      </SaveBar>

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
      <SessionsCard
        classProduct={classProduct}
        variantTitleById={variantTitleById}
        busy={busy}
      />
      <ShopifyVariantImportCard rows={importRows} setRows={setImportRows} />
      <AddSessionsCard rows={newSessionRows} setRows={setNewSessionRows} />
      <ClassSummary
        classProduct={classProduct}
        title={title}
        locations={locations}
        locationId={locationId}
        durationMin={durationMin}
      />
      <ClassActivityTimeline items={activityItems} />

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
        <input
          type="hidden"
          name="newSessions"
          value={JSON.stringify(newSessionPayload)}
        />
        <input
          type="hidden"
          name="shopifyLocationGid"
          value={shopifyLocationGid}
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

function ClassSummary({
  classProduct,
  title,
  locations,
  locationId,
  durationMin,
}: {
  classProduct: ClassProductWith;
  title: string;
  locations: { id: string; name: string }[];
  locationId: string;
  durationMin: string;
}) {
  const now = new Date();
  const locationName =
    locations.find((location) => location.id === locationId)?.name ??
    classProduct.location?.name ??
    "No location";
  const sessionCount = classProduct.sessions.length;
  const upcomingCount = classProduct.sessions.filter((session) => {
    const startsAt =
      typeof session.startsAt === "string"
        ? new Date(session.startsAt)
        : session.startsAt;
    return !session.cancelled && startsAt > now;
  }).length;
  const duration = Number(durationMin);
  const durationLabel = Number.isFinite(duration)
    ? `${duration} minute${duration === 1 ? "" : "s"}`
    : `${durationMin} minutes`;
  const statusLabel = formatStatusLabel(classProduct.status);

  return (
    <s-box slot="aside">
      <s-section
        heading="Class summary"
        accessibilityLabel="Class summary"
      >
        <s-stack direction="block" gap="large">
          <s-stack
            direction="inline"
            gap="base"
            alignItems="start"
            justifyContent="space-between"
          >
            <s-text type="strong">{title || classProduct.title}</s-text>
            <s-badge
              color="base"
              tone={statusBadgeTone(classProduct.status)}
            >
              {statusLabel}
            </s-badge>
          </s-stack>
          <s-stack direction="block" gap="small">
            <s-heading>Details</s-heading>
            <s-unordered-list>
              <s-list-item>{locationName}</s-list-item>
              <s-list-item>{durationLabel}</s-list-item>
              <s-list-item>
                {sessionCount} session{sessionCount === 1 ? "" : "s"}
              </s-list-item>
              <s-list-item>{upcomingCount} upcoming</s-list-item>
            </s-unordered-list>
          </s-stack>
        </s-stack>
      </s-section>
    </s-box>
  );
}

function ClassActivityTimeline({ items }: { items: ClassActivityItem[] }) {
  let lastDate: string | null = null;

  return (
    <s-section heading="Timeline" accessibilityLabel="Class timeline">
      {items.length > 0 ? (
        <s-stack direction="block" gap="base">
          {items.map((item, index) => {
            const timestamp = item.timestamp.setZone(CLASS_TIMEZONE);
            const dateLabel = timestamp.toLocaleString({
              year: "numeric",
              month: "long",
              day: "numeric",
            });
            const showDate = dateLabel !== lastDate;
            lastDate = dateLabel;

            return (
              <Fragment key={`${timestamp.toISO()}-${index}`}>
                {showDate && (
                  <s-grid
                    gridTemplateColumns="30px 1fr 90px"
                    columnGap="small"
                    alignItems="start"
                  >
                    <s-box />
                    <s-text color="subdued">{dateLabel}</s-text>
                    <s-box />
                  </s-grid>
                )}
                <s-grid
                  gridTemplateColumns="30px 1fr 90px"
                  columnGap="small"
                  alignItems="start"
                >
                  <span className={styles.timelineIcon}>
                    <TimelineMarker tone={item.tone} />
                  </span>
                  <s-stack
                    direction="inline"
                    gap="small-200"
                    alignItems="center"
                  >
                    {item.icon ? (
                      <s-icon type={item.icon} color="subdued" />
                    ) : null}
                    <s-text>{item.message}</s-text>
                  </s-stack>
                  <s-stack alignItems="end">
                    <s-text color="subdued">
                      {timestamp.toFormat("h:mm a")}
                    </s-text>
                  </s-stack>
                </s-grid>
              </Fragment>
            );
          })}
        </s-stack>
      ) : (
        <s-text>No timeline events available.</s-text>
      )}
    </s-section>
  );
}

function TimelineMarker({ tone }: { tone?: ClassActivityTone }) {
  const bulletIcon = getTimelineBulletIcon(tone);

  if (bulletIcon) {
    return (
      <span className={styles.timelineIconPolarisIcon}>
        <s-icon type={bulletIcon.type} tone={bulletIcon.tone} />
      </span>
    );
  }

  return (
    <span className={styles.timelineIconBase}>
      <span className={styles.timelineIconBaseInner} />
    </span>
  );
}

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
    <s-section
      heading="Event defaults"
      accessibilityLabel="Class event defaults"
    >
      <s-stack direction="block" gap="base">
        <s-text-field
          label="Internal event name"
          value={title}
          required
          onChange={(e) => setTitle((e.target as HTMLInputElement).value)}
        />
        <s-select
          label="Location"
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
          <s-select
            label="Duration"
            icon="clock"
            value={durationMin}
            onChange={(e) =>
              setDurationMin((e.target as HTMLSelectElement).value)
            }
          >
            <s-option value="30">30 min</s-option>
            <s-option value="60">1 hour</s-option>
            <s-option value="90">1 hr 30 min</s-option>
            <s-option value="120">2 hours</s-option>
            <s-option value="150">2 hr 30 min</s-option>
          </s-select>
          <s-number-field
            label="Seats per session"
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
  variantTitleById,
  busy,
}: {
  classProduct: ClassProductWith;
  variantTitleById: Record<string, string>;
  busy: boolean;
}) {
  const [query, setQuery] = useState("");
  const [sortField, setSortField] = useState<SessionSortField>("date");
  const [selectedSessionIds, setSelectedSessionIds] = useState<Set<string>>(
    () => new Set(),
  );
  const now = new Date();
  const sessions = [...classProduct.sessions].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );
  const rows = sessions.map((session) => {
    const iso =
      typeof session.startsAt === "string"
        ? session.startsAt
        : session.startsAt.toISOString();
    const startsAt = DateTime.fromISO(iso, { zone: CLASS_TIMEZONE });
    const variantTitle =
      variantTitleById[session.variantGid] ??
      formatSessionTitle(iso, CLASS_TIMEZONE);
    const upcoming = !session.cancelled && new Date(iso) > now;
    const status = session.cancelled
      ? "Cancelled"
      : upcoming
        ? "Upcoming"
        : "Past";

    return {
      session,
      variantTitle,
      status,
      upcoming,
      startsAtMillis: startsAt.toMillis(),
      editDate: startsAt.toFormat("yyyy-LL-dd"),
      editTime: startsAt.toFormat("HH:mm"),
      displayDate: startsAt.toFormat("ccc LLL d"),
      displayTime: startsAt.toFormat("h:mm a"),
    };
  });
  const sortedRows = [...rows].sort((a, b) => {
    switch (sortField) {
      case "seats":
        return a.session.capacity - b.session.capacity;
      case "status":
        return a.status.localeCompare(b.status, undefined, {
          numeric: true,
          sensitivity: "base",
        });
      case "date":
      default:
        return a.startsAtMillis - b.startsAtMillis;
    }
  });
  const normalizedQuery = query.trim().toLowerCase();
  const visibleRows = normalizedQuery
    ? sortedRows.filter(
        ({ session, status, variantTitle, displayDate, displayTime }) =>
          [
            variantTitle,
            status,
            String(session.capacity),
            session.sku,
            displayDate,
            displayTime,
          ]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery),
      )
    : sortedRows;
  const selectedVisibleCount = visibleRows.filter(({ session }) =>
    selectedSessionIds.has(session.id),
  ).length;
  const allVisibleSelected =
    visibleRows.length > 0 && selectedVisibleCount === visibleRows.length;
  const someVisibleSelected =
    selectedVisibleCount > 0 && selectedVisibleCount < visibleRows.length;
  const setSessionSelected = (sessionId: string, checked: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      if (checked) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }
      return next;
    });
  };
  const setVisibleSessionsSelected = (checked: boolean) => {
    setSelectedSessionIds((current) => {
      const next = new Set(current);
      visibleRows.forEach(({ session }) => {
        if (checked) {
          next.add(session.id);
        } else {
          next.delete(session.id);
        }
      });
      return next;
    });
  };
  const selectedSessionCount = selectedSessionIds.size;

  return (
    <s-section
      accessibilityLabel="Sessions"
      padding={sessions.length === 0 ? "base" : "none"}
    >
      {sessions.length === 0 ? (
        <s-text tone="neutral">No sessions yet. Add dates below.</s-text>
      ) : (
        <s-table>
          {selectedSessionCount > 0 ? (
            <s-box
              slot="filters"
              padding="small"
              background="strong"
              borderRadius="base"
            >
              <s-grid gridTemplateColumns="1fr auto" alignItems="center">
                <s-stack direction="inline" gap="small" alignItems="center">
                  <s-text type="strong">
                    {selectedSessionCount} selected
                  </s-text>
                </s-stack>
                <s-button
                  icon="menu-horizontal"
                  variant="secondary"
                  accessibilityLabel="Actions"
                  commandFor="sessions-more-actions"
                />
                <s-menu
                  id="sessions-more-actions"
                  accessibilityLabel="Session actions"
                >
                  <s-button icon="delete" tone="critical">
                    Delete product
                  </s-button>
                </s-menu>
              </s-grid>
            </s-box>
          ) : (
            <s-grid
              slot="filters"
              gap="small-200"
              gridTemplateColumns="1fr auto"
            >
              <s-search-field
                label="Search sessions"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search sessions"
                value={query}
                onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
              />
              <s-button
                icon="sort"
                variant="secondary"
                accessibilityLabel="Sort"
                commandFor="sessions-sort-actions"
              />
              <s-popover id="sessions-sort-actions">
                <s-stack gap="none">
                  <s-box padding="small">
                    <s-choice-list
                      label="Sort by"
                      name="sessions-sort-by"
                      values={[sortField]}
                      onChange={(event) => {
                        const next = event.currentTarget.values[0];
                        if (next) setSortField(next as SessionSortField);
                      }}
                    >
                      {SESSION_SORT_OPTIONS.map((option) => (
                        <s-choice key={option.field} value={option.field}>
                          {option.label}
                        </s-choice>
                      ))}
                    </s-choice-list>
                  </s-box>
                </s-stack>
              </s-popover>
            </s-grid>
          )}
          <s-table-header-row>
            <s-table-header listSlot="inline">
              <s-checkbox
                accessibilityLabel="Select all sessions"
                checked={allVisibleSelected}
                indeterminate={someVisibleSelected}
                onChange={(event) =>
                  setVisibleSessionsSelected(event.currentTarget.checked)
                }
              />
            </s-table-header>
            <s-table-header listSlot="primary">Variant</s-table-header>
            <s-table-header listSlot="secondary">Status</s-table-header>
            <s-table-header listSlot="labeled">SKU</s-table-header>
            <s-table-header format="numeric" listSlot="labeled">
              Seats
            </s-table-header>
            <s-table-header listSlot="labeled">Date</s-table-header>
            <s-table-header listSlot="labeled">Time</s-table-header>
            <s-table-header listSlot="inline"></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {visibleRows.map(
              ({
                session,
                variantTitle,
                status,
                upcoming,
                editDate,
                editTime,
                displayDate,
                displayTime,
              }) => {
                const checkboxId = `session-${session.id}-checkbox`;
                const editModalId = `session-${session.id}-edit`;

                return (
                  <s-table-row key={session.id} clickDelegate={checkboxId}>
                    <s-table-cell>
                      <s-checkbox
                        id={checkboxId}
                        accessibilityLabel={`Select ${variantTitle}`}
                        checked={selectedSessionIds.has(session.id)}
                        onChange={(event) =>
                          setSessionSelected(
                            session.id,
                            event.currentTarget.checked,
                          )
                        }
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <s-text>{variantTitle}</s-text>
                    </s-table-cell>
                    <s-table-cell>
                      {status === "Cancelled" ? (
                        <s-badge tone="critical">Cancelled</s-badge>
                      ) : upcoming ? (
                        <s-badge tone="success">Upcoming</s-badge>
                      ) : (
                        <s-badge>Past</s-badge>
                      )}
                    </s-table-cell>
                    <s-table-cell>{session.sku}</s-table-cell>
                    <s-table-cell>{session.capacity}</s-table-cell>
                    <s-table-cell>{displayDate}</s-table-cell>
                    <s-table-cell>{displayTime}</s-table-cell>
                    <s-table-cell>
                      <s-button
                        icon="edit"
                        variant="tertiary"
                        accessibilityLabel={`Edit ${variantTitle}`}
                        commandFor={editModalId}
                        command="--show"
                      />
                      <EditSessionModal
                        id={editModalId}
                        sessionId={session.id}
                        variantTitle={variantTitle}
                        defaultDate={editDate}
                        defaultTime={editTime}
                        busy={busy}
                      />
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

function EditSessionModal({
  id,
  sessionId,
  variantTitle,
  defaultDate,
  defaultTime,
  busy,
}: {
  id: string;
  sessionId: string;
  variantTitle: string;
  defaultDate: string;
  defaultTime: string;
  busy: boolean;
}) {
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState(defaultTime);

  return (
    <Form method="post" className={styles.editSessionForm}>
      <input type="hidden" name="intent" value="edit-session" />
      <input type="hidden" name="sessionId" value={sessionId} />
      <input type="hidden" name="date" value={date} />
      <input type="hidden" name="time" value={time} />
      <s-modal id={id} heading={variantTitle} size="small-100">
        <s-grid
          gridTemplateColumns="repeat(2, minmax(0, 1fr))"
          gap="base"
          justifyItems="stretch"
        >
          <s-text-field
            label="Date"
            icon="calendar"
            placeholder="YYYY-MM-DD"
            value={date}
            onChange={(event) =>
              setDate((event.target as HTMLInputElement).value)
            }
          />
          <s-select
            label="Start time"
            icon="clock"
            value={time}
            onChange={(event) =>
              setTime((event.target as HTMLSelectElement).value)
            }
          >
            {SESSION_TIME_OPTIONS.map((option) => (
              <s-option key={option.value} value={option.value}>
                {option.label}
              </s-option>
            ))}
          </s-select>
        </s-grid>
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          loading={busy ? true : undefined}
        >
          Save
        </s-button>
        <s-button
          slot="secondary-actions"
          variant="secondary"
          commandFor={id}
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </Form>
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
  rows,
  setRows,
}: {
  rows: NewSessionDraftRow[];
  setRows: Dispatch<SetStateAction<NewSessionDraftRow[]>>;
}) {
  const enabled = rows.length > 0;
  const todayIso = DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd");
  const yesterdayIso = DateTime.fromISO(todayIso)
    .minus({ days: 1 })
    .toFormat("yyyy-LL-dd");

  return (
    <s-section accessibilityLabel="Add sessions">
      <s-stack direction="block" gap="base">
        <s-stack
          direction="inline"
          justifyContent="space-between"
          alignItems="center"
        >
          <s-heading>Add sessions</s-heading>
          <s-stack direction="inline" gap="small-200" alignItems="center">
            <s-stack direction="inline" gap="small-400" alignItems="center">
              <s-text color="subdued">Creates variants on save</s-text>
              <s-tooltip id="add-sessions-variants-tooltip">
                Each session row is created as a Shopify product variant when
                you save.
              </s-tooltip>
              <s-icon
                type="info"
                color="subdued"
                interestFor="add-sessions-variants-tooltip"
              />
            </s-stack>
            <s-switch
              label="Add sessions"
              labelAccessibilityVisibility="exclusive"
              checked={enabled}
              onChange={(e) => {
                const checked = (e.target as HTMLInputElement).checked;
                setRows((current) =>
                  checked
                    ? current.length > 0
                      ? current
                      : [buildNewSessionDraftRow()]
                    : [],
                );
              }}
            />
          </s-stack>
        </s-stack>

        {enabled &&
          rows.map((row, idx) => (
            <s-grid
              key={idx}
              gridTemplateColumns="minmax(0, 1fr) minmax(0, 1fr) auto"
              gap="base"
              alignItems="end"
            >
              <s-date-field
                label="Date"
                labelAccessibilityVisibility={
                  idx === 0 ? "visible" : "exclusive"
                }
                disallow={`--${yesterdayIso}`}
                value={row.date}
                onChange={(e) => {
                  const nextDate = (e.target as HTMLInputElement).value;
                  if (nextDate && nextDate < todayIso) return;
                  setRows((rs) =>
                    rs.map((r, i) =>
                      i === idx
                        ? {
                            ...r,
                            date: nextDate,
                          }
                        : r,
                    ),
                  );
                }}
              />
              <s-select
                label="Start time"
                labelAccessibilityVisibility={
                  idx === 0 ? "visible" : "exclusive"
                }
                icon="clock"
                value={row.time}
                onChange={(e) =>
                  setRows((rs) =>
                    rs.map((r, i) =>
                      i === idx
                        ? {
                            ...r,
                            time: (e.target as HTMLInputElement).value,
                          }
                        : r,
                    ),
                  )
                }
              >
                {SESSION_TIME_OPTIONS.map((option) => (
                  <s-option key={option.value} value={option.value}>
                    {option.label}
                  </s-option>
                ))}
              </s-select>
              <s-button-group accessibilityLabel="Session row actions">
                <s-button
                  slot="secondary-actions"
                  tone="critical"
                  onClick={() =>
                    setRows((rs) => rs.filter((_, i) => i !== idx))
                  }
                  disabled={rows.length === 1}
                >
                  Delete
                </s-button>
              </s-button-group>
            </s-grid>
          ))}

        {enabled && (
          <s-button-group accessibilityLabel="Session actions">
            <s-button
              slot="secondary-actions"
              icon="plus"
              type="button"
              onClick={() =>
                setRows((rs) => [
                  ...rs,
                  {
                    date: rs[rs.length - 1]?.date ?? "",
                    time: rs[rs.length - 1]?.time ?? "15:00",
                  },
                ])
              }
            >
              Add another session
            </s-button>
          </s-button-group>
        )}
      </s-stack>
    </s-section>
  );
}

function buildDefaultNewSessionRows(): NewSessionDraftRow[] {
  return [];
}

function buildNewSessionDraftRow(): NewSessionDraftRow {
  return {
    date: DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd"),
    time: "15:00",
  };
}

function buildNewSessionPayload(rows: NewSessionDraftRow[]): NewSessionInput[] {
  return rows.map((row) => ({
    startsAt:
      row.date && row.time
        ? DateTime.fromISO(`${row.date}T${row.time}`, {
            zone: CLASS_TIMEZONE,
          }).toISO()
        : null,
  }));
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

function buildClassActivityItems(
  classProduct: ClassProductWith,
  variantTitleById: Record<string, string>,
): ClassActivityItem[] {
  const items: ClassActivityItem[] = [];
  const classCreatedAt = toClassDateTime(classProduct.createdAt);
  const classUpdatedAt = toClassDateTime(classProduct.updatedAt);

  if (classCreatedAt.isValid) {
    items.push({
      message: "Class created.",
      timestamp: classCreatedAt,
      tone: "success",
      icon: "product",
    });
  }

  if (isMeaningfullyLater(classUpdatedAt, classCreatedAt)) {
    items.push({
      message: "Class details updated.",
      timestamp: classUpdatedAt,
      tone: "base",
      icon: "edit",
    });
  }

  for (const session of classProduct.sessions) {
    const startsAt =
      typeof session.startsAt === "string"
        ? session.startsAt
        : session.startsAt.toISOString();
    const sessionCreatedAt = toClassDateTime(session.createdAt);
    const sessionUpdatedAt = toClassDateTime(session.updatedAt);
    const variantTitle =
      variantTitleById[session.variantGid] ??
      formatSessionTitle(startsAt, CLASS_TIMEZONE);

    if (sessionCreatedAt.isValid) {
      items.push({
        message: `Session added: ${variantTitle}.`,
        timestamp: sessionCreatedAt,
        tone: "base",
        icon: "calendar",
      });
    }

    if (session.cancelled) {
      if (sessionUpdatedAt.isValid) {
        items.push({
          message: `Session cancelled: ${variantTitle}.`,
          timestamp: sessionUpdatedAt,
          tone: "critical",
          icon: "calendar",
        });
      }
    } else if (isMeaningfullyLater(sessionUpdatedAt, sessionCreatedAt)) {
      items.push({
        message: `Session updated: ${variantTitle}.`,
        timestamp: sessionUpdatedAt,
        tone: "base",
        icon: "edit",
      });
    }
  }

  return items.sort((a, b) => b.timestamp.toMillis() - a.timestamp.toMillis());
}

function toClassDateTime(value: Date | string): DateTime {
  return typeof value === "string"
    ? DateTime.fromISO(value, { zone: CLASS_TIMEZONE })
    : DateTime.fromJSDate(value).setZone(CLASS_TIMEZONE);
}

function isMeaningfullyLater(later: DateTime, earlier: DateTime): boolean {
  return (
    later.isValid &&
    earlier.isValid &&
    later.toMillis() - earlier.toMillis() > 60_000
  );
}

function getTimelineBulletIcon(tone?: ClassActivityTone) {
  if (tone === "critical" || tone === "caution") {
    return { type: "alert-circle" as const, tone };
  }

  if (tone === "success") {
    return { type: "check-circle" as const, tone };
  }

  return null;
}

function productNumericId(gid: string): string {
  return gid.split("/").pop() ?? "";
}

function formatStatusLabel(status: string): string {
  return status ? status.charAt(0).toUpperCase() + status.slice(1) : "Draft";
}

function statusBadgeTone(status: string): StatusBadgeTone {
  if (status === "active") return "success";
  if (status === "archived") return "critical";
  return "info";
}

function shopifyMutationError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Couldn't update the Shopify product.";
}
