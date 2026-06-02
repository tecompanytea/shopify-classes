import { useMemo, useState } from "react";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CLASS_TIMEZONE } from "../lib/class-config";
import { formatSessionTitle, generateSessionSku } from "../lib/sku";
import { ensureSessionDateOption } from "../.server/shopify/products";
import {
  createSessionVariants,
  deleteVariants,
  setInventoryAtLocation,
  updateSessionVariant,
  type SessionDraft,
} from "../.server/shopify/variants";
import {
  getShopCurrency,
  listShopifyLocations,
} from "../.server/shopify/locations";

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
    db.location.findMany({ where: { shop: session.shop, archived: false }, orderBy: { name: "asc" } }),
    listShopifyLocations(admin),
  ]);

  if (!classProduct) throw new Response("Not found", { status: 404 });

  return { classProduct, locations, shopifyLocations };
};

type ActionData =
  | { error: string }
  | { ok: true; message: string };

export const action = async ({ request, params }: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const id = String(params.id);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  const classProduct = await db.classProduct.findFirst({
    where: { id, shop: session.shop },
  });
  if (!classProduct) throw new Response("Not found", { status: 404 });

  if (intent === "update-defaults") {
    const locationId = String(form.get("locationId") ?? "") || null;
    const durationMin = Number(form.get("durationMin") ?? classProduct.durationMin);
    const defaultCapacity = Number(form.get("defaultCapacity") ?? classProduct.defaultCapacity);

    await db.classProduct.update({
      where: { id },
      data: {
        locationId,
        timezone: CLASS_TIMEZONE,
        durationMin,
        defaultCapacity,
        defaultPriceCents: null,
      },
    });
    return { ok: true, message: "Defaults updated." };
  }

  if (intent === "add-sessions") {
    const shopifyLocationGid = String(form.get("shopifyLocationGid") ?? "");
    if (!shopifyLocationGid) return { error: "Pick an inventory location." };
    let parsed: Array<{ startsAt: string; capacity?: number }>;
    try {
      parsed = JSON.parse(String(form.get("sessions") ?? "[]"));
    } catch {
      return { error: "Couldn't read sessions." };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return { error: "Add at least one session." };

    const drafts: SessionDraft[] = parsed.map((s) => {
      const startsAt = DateTime.fromISO(s.startsAt, { zone: CLASS_TIMEZONE });
      const endsAt = startsAt.plus({ minutes: classProduct.durationMin });
      return {
        startsAt: startsAt.toJSDate(),
        endsAt: endsAt.toJSDate(),
        timezone: CLASS_TIMEZONE,
        capacity: s.capacity ?? classProduct.defaultCapacity,
        sku: generateSessionSku(classProduct.title, startsAt.toISO()!, CLASS_TIMEZONE),
        displayName: formatSessionTitle(startsAt.toISO()!, CLASS_TIMEZONE),
      };
    });

    if (drafts.some((d) => Number.isNaN(d.startsAt.getTime()))) {
      return { error: "One or more sessions has an invalid time. Use 24-hour HH:MM (e.g. 09:30)." };
    }

    await ensureSessionDateOption(admin, classProduct.productGid);
    const currencyCode = await getShopCurrency(admin);
    const created = await createSessionVariants(admin, {
      productGid: classProduct.productGid,
      drafts,
      currencyCode,
    });

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

    return { ok: true, message: `Added ${created.length} session${created.length === 1 ? "" : "s"}.` };
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

    const startsAt = DateTime.fromISO(`${date}T${time}`, { zone: CLASS_TIMEZONE });
    if (!startsAt.isValid) {
      return { error: "Enter a valid date and 24-hour time (e.g. 09:30)." };
    }
    const endsAt = startsAt.plus({ minutes: classProduct.durationMin });
    const startsAtIso = startsAt.toISO()!;
    const sku = generateSessionSku(classProduct.title, startsAtIso, CLASS_TIMEZONE);
    const displayName = formatSessionTitle(startsAtIso, CLASS_TIMEZONE);

    // Update Shopify first; if it fails (e.g. duplicate date) we surface the
    // error and leave the local row untouched.
    await updateSessionVariant(admin, {
      productGid: classProduct.productGid,
      variantId: target.variantGid,
      displayName,
      sku,
    });

    await db.classSession.update({
      where: { id: target.id },
      data: { startsAt: startsAt.toJSDate(), endsAt: endsAt.toJSDate(), sku },
    });

    return { ok: true, message: "Session updated." };
  }

  if (intent === "archive-class") {
    await db.classProduct.update({
      where: { id },
      data: { status: "archived" },
    });
    return redirect("/app/classes");
  }

  return { error: "Unknown action." };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function ClassDetail() {
  const { classProduct, locations, shopifyLocations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <s-page heading={classProduct.title} back-href="/app/classes">
      <s-button slot="primary-action" href={`shopify://admin/products/${productNumericId(classProduct.productGid)}`} target="_top">
        Open in Shopify
      </s-button>

      {actionData && "ok" in actionData && (
        <s-banner tone="success">{actionData.message}</s-banner>
      )}
      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <SessionsCard classProduct={classProduct} busy={busy} />
      <AddSessionsCard shopifyLocations={shopifyLocations} busy={busy} />

      <DefaultsCard classProduct={classProduct} locations={locations} busy={busy} />
      <DangerZone busy={busy} />
    </s-page>
  );
}

type ClassProductWith = Awaited<ReturnType<typeof loader>>["classProduct"];

function DefaultsCard({
  classProduct,
  locations,
  busy,
}: {
  classProduct: ClassProductWith;
  locations: { id: string; name: string }[];
  busy: boolean;
}) {
  return (
    <s-section slot="aside" heading="Event defaults">
      <Form method="post">
        <input type="hidden" name="intent" value="update-defaults" />
        <s-stack direction="block" gap="base">
          <s-select label="Display location" name="locationId" value={classProduct.locationId ?? ""}>
            <s-option value="">None</s-option>
            {locations.map((l) => (
              <s-option key={l.id} value={l.id}>{l.name}</s-option>
            ))}
          </s-select>
          <s-number-field
            name="durationMin"
            label="Duration (minutes)"
            defaultValue={String(classProduct.durationMin)}
          />
          <s-number-field
            name="defaultCapacity"
            label="Default capacity (seats)"
            defaultValue={String(classProduct.defaultCapacity)}
          />
          <s-paragraph>Class price comes from the Shopify product.</s-paragraph>
          <s-button type="submit" variant="primary" loading={busy ? true : undefined}>
            Save defaults
          </s-button>
        </s-stack>
      </Form>
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
  const now = new Date();
  const sessions = [...classProduct.sessions].sort(
    (a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime(),
  );

  return (
    <s-section heading={`Sessions · ${classProduct.sessions.length}`}>
      {sessions.length === 0 ? (
        <s-text tone="neutral">No sessions yet. Add dates below.</s-text>
      ) : (
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Date</s-table-header>
            <s-table-header listSlot="inline">Status</s-table-header>
            <s-table-header format="numeric" listSlot="labeled">Seats</s-table-header>
            <s-table-header listSlot="labeled">SKU</s-table-header>
            <s-table-header></s-table-header>
          </s-table-header-row>
          <s-table-body>
            {sessions.map((s) => {
              const iso =
                typeof s.startsAt === "string" ? s.startsAt : s.startsAt.toISOString();
              const title = formatSessionTitle(iso, CLASS_TIMEZONE);
              const editDt = DateTime.fromISO(iso, { zone: CLASS_TIMEZONE });
              const editDate = editDt.toFormat("yyyy-LL-dd");
              const editTime = editDt.toFormat("HH:mm");
              const upcoming = !s.cancelled && new Date(iso) > now;
              return (
                <s-table-row key={s.id}>
                  <s-table-cell>{title}</s-table-cell>
                  <s-table-cell>
                    {s.cancelled ? (
                      <s-badge tone="critical">Cancelled</s-badge>
                    ) : upcoming ? (
                      <s-badge tone="success">Upcoming</s-badge>
                    ) : (
                      <s-badge>Past</s-badge>
                    )}
                  </s-table-cell>
                  <s-table-cell>{s.capacity}</s-table-cell>
                  <s-table-cell>{s.sku}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      <EditSessionPopover
                        sessionId={s.id}
                        title={title}
                        defaultDate={editDate}
                        defaultTime={editTime}
                        busy={busy}
                      />
                      <Form method="post">
                        <input type="hidden" name="intent" value="remove-session" />
                        <input type="hidden" name="sessionId" value={s.id} />
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
            })}
          </s-table-body>
        </s-table>
      )}
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
  const [shopifyLocationGid, setShopifyLocationGid] = useState(shopifyLocations[0]?.id ?? "");

  const payload = useMemo(
    () =>
      draftRows
        .filter((r) => r.date && r.time)
        .map((r) => ({
          startsAt: DateTime.fromISO(`${r.date}T${r.time}`, { zone: CLASS_TIMEZONE }).toISO(),
        })),
    [draftRows],
  );

  return (
    <s-section heading="Add sessions">
      <s-stack direction="block" gap="base">
        <s-select
          label="Shopify inventory location"
          value={shopifyLocationGid}
          onChange={(e) => setShopifyLocationGid((e.target as HTMLSelectElement).value)}
        >
          {shopifyLocations.map((l) => (
            <s-option key={l.id} value={l.id}>{l.name}</s-option>
          ))}
        </s-select>

        {draftRows.map((row, idx) => (
          <s-stack key={idx} direction="inline" gap="base">
            <s-date-field
              label={idx === 0 ? "Date" : undefined}
              value={row.date}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) => (i === idx ? { ...r, date: (e.target as HTMLInputElement).value } : r)),
                )
              }
            />
            <s-text-field
              label={idx === 0 ? "Start time" : undefined}
              placeholder="15:00"
              value={row.time}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) => (i === idx ? { ...r, time: (e.target as HTMLInputElement).value } : r)),
                )
              }
            />
            <s-button
              variant="tertiary"
              tone="critical"
              onClick={() => setDraftRows((rs) => rs.filter((_, i) => i !== idx))}
              disabled={draftRows.length === 1}
            >
              Remove
            </s-button>
          </s-stack>
        ))}

        <s-button
          onClick={() =>
            setDraftRows((rs) => [
              ...rs,
              { date: rs[rs.length - 1]?.date ?? "", time: rs[rs.length - 1]?.time ?? "15:00" },
            ])
          }
        >
          Add row
        </s-button>

        <Form method="post">
          <input type="hidden" name="intent" value="add-sessions" />
          <input type="hidden" name="shopifyLocationGid" value={shopifyLocationGid} />
          <input type="hidden" name="sessions" value={JSON.stringify(payload)} />
          <s-button type="submit" variant="primary" loading={busy ? true : undefined}>
            Generate variants
          </s-button>
        </Form>
      </s-stack>
    </s-section>
  );
}

function DangerZone({ busy }: { busy: boolean }) {
  return (
    <s-section slot="aside" heading="Archive">
      <s-paragraph>
        Archiving hides this event from the list. Variants in Shopify are not
        removed — manage them in Shopify if you need to delist the product.
      </s-paragraph>
      <Form method="post">
        <input type="hidden" name="intent" value="archive-class" />
        <s-button type="submit" tone="critical" loading={busy ? true : undefined}>
          Archive event
        </s-button>
      </Form>
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
                label="Start time"
                placeholder="15:00"
                details="24-hour, e.g. 09:30"
                value={time}
                onChange={(e) => setTime((e.target as HTMLInputElement).value)}
              />
              <s-button type="submit" variant="primary" loading={busy ? true : undefined}>
                Save
              </s-button>
            </s-stack>
          </Form>
        </s-box>
      </s-popover>
    </>
  );
}

function productNumericId(gid: string): string {
  // gid://shopify/Product/12345 -> 12345
  return gid.split("/").pop() ?? "";
}
