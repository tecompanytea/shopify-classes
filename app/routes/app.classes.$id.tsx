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
import { SUPPORTED_TIMEZONES } from "../lib/timezones";
import { formatSessionTitle, generateSessionSku } from "../lib/sku";
import { ensureSessionDateOption } from "../.server/shopify/products";
import {
  createSessionVariants,
  deleteVariants,
  setInventoryAtLocation,
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
    const timezone = String(form.get("timezone") ?? classProduct.timezone);
    const durationMin = Number(form.get("durationMin") ?? classProduct.durationMin);
    const defaultCapacity = Number(form.get("defaultCapacity") ?? classProduct.defaultCapacity);
    const defaultPriceRaw = form.get("defaultPriceCents");
    const defaultPriceCents = defaultPriceRaw === null || defaultPriceRaw === ""
      ? null
      : Number(defaultPriceRaw);

    await db.classProduct.update({
      where: { id },
      data: { locationId, timezone, durationMin, defaultCapacity, defaultPriceCents },
    });
    return { ok: true, message: "Defaults updated." };
  }

  if (intent === "add-sessions") {
    const shopifyLocationGid = String(form.get("shopifyLocationGid") ?? "");
    if (!shopifyLocationGid) return { error: "Pick an inventory location." };
    let parsed: Array<{ startsAt: string; capacity?: number; priceCents?: number | null }>;
    try {
      parsed = JSON.parse(String(form.get("sessions") ?? "[]"));
    } catch {
      return { error: "Couldn't read sessions." };
    }
    if (!Array.isArray(parsed) || parsed.length === 0) return { error: "Add at least one session." };

    const drafts: SessionDraft[] = parsed.map((s) => {
      const startsAt = DateTime.fromISO(s.startsAt, { zone: classProduct.timezone });
      const endsAt = startsAt.plus({ minutes: classProduct.durationMin });
      return {
        startsAt: startsAt.toJSDate(),
        endsAt: endsAt.toJSDate(),
        timezone: classProduct.timezone,
        capacity: s.capacity ?? classProduct.defaultCapacity,
        priceCents: s.priceCents ?? classProduct.defaultPriceCents,
        sku: generateSessionSku(classProduct.title, startsAt.toISO()!, classProduct.timezone),
        displayName: formatSessionTitle(startsAt.toISO()!, classProduct.timezone),
      };
    });

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
        timezone: classProduct.timezone,
        capacity: drafts[idx].capacity,
        priceCents: drafts[idx].priceCents ?? null,
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

  if (intent === "archive-class") {
    await db.classProduct.update({
      where: { id },
      data: { status: "archived" },
    });
    return redirect("/app");
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
    <s-page heading={classProduct.title} back-href="/app">
      <s-button slot="primary-action" href={`shopify://admin/products/${productNumericId(classProduct.productGid)}`} target="_top">
        Open in Shopify
      </s-button>

      {actionData && "ok" in actionData && (
        <s-banner tone="success">{actionData.message}</s-banner>
      )}
      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <DefaultsCard classProduct={classProduct} locations={locations} busy={busy} />
      <SessionsCard classProduct={classProduct} shopifyLocations={shopifyLocations} busy={busy} />
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
    <s-section heading="Class defaults">
      <Form method="post">
        <input type="hidden" name="intent" value="update-defaults" />
        <s-stack direction="block" gap="base">
          <s-select label="Timezone" name="timezone" defaultValue={classProduct.timezone}>
            {SUPPORTED_TIMEZONES.map((tz) => (
              <s-option key={tz.value} value={tz.value}>{tz.label}</s-option>
            ))}
          </s-select>
          <s-select label="Display location" name="locationId" defaultValue={classProduct.locationId ?? ""}>
            <s-option value="">None</s-option>
            {locations.map((l) => (
              <s-option key={l.id} value={l.id}>{l.name}</s-option>
            ))}
          </s-select>
          <s-text-field
            type="number"
            name="durationMin"
            label="Duration (minutes)"
            defaultValue={String(classProduct.durationMin)}
          />
          <s-text-field
            type="number"
            name="defaultCapacity"
            label="Default capacity (seats)"
            defaultValue={String(classProduct.defaultCapacity)}
          />
          <s-text-field
            type="number"
            name="defaultPriceCents"
            label="Default price (cents)"
            details="Leave blank to inherit product price."
            defaultValue={classProduct.defaultPriceCents != null ? String(classProduct.defaultPriceCents) : ""}
          />
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
  shopifyLocations,
  busy,
}: {
  classProduct: ClassProductWith;
  shopifyLocations: { id: string; name: string }[];
  busy: boolean;
}) {
  const [draftRows, setDraftRows] = useState<{ date: string; time: string }[]>([
    {
      date: DateTime.now().setZone(classProduct.timezone).toFormat("yyyy-LL-dd"),
      time: "15:00",
    },
  ]);
  const [shopifyLocationGid, setShopifyLocationGid] = useState(shopifyLocations[0]?.id ?? "");

  const payload = useMemo(
    () =>
      draftRows
        .filter((r) => r.date && r.time)
        .map((r) => ({
          startsAt: DateTime.fromISO(`${r.date}T${r.time}`, { zone: classProduct.timezone }).toISO(),
        })),
    [draftRows, classProduct.timezone],
  );

  const upcoming = classProduct.sessions.filter((s) => !s.cancelled && new Date(s.startsAt) > new Date());
  const past = classProduct.sessions.filter((s) => s.cancelled || new Date(s.startsAt) <= new Date());

  return (
    <s-section heading={`Sessions · ${classProduct.sessions.length}`}>
      <s-stack direction="block" gap="base">
        <h3 style={{ margin: 0 }}>Upcoming</h3>
        {upcoming.length === 0 && <s-text tone="subdued">No upcoming sessions.</s-text>}
        {upcoming.map((s) => (
          <SessionRow key={s.id} session={s} timezone={classProduct.timezone} />
        ))}

        <details>
          <summary>Past / cancelled ({past.length})</summary>
          <s-stack direction="block" gap="base">
            {past.map((s) => (
              <SessionRow key={s.id} session={s} timezone={classProduct.timezone} />
            ))}
          </s-stack>
        </details>

        <s-divider />

        <h3 style={{ margin: 0 }}>Add sessions</h3>
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
            <s-text-field
              type="date"
              label={idx === 0 ? "Date" : undefined}
              value={row.date}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) => (i === idx ? { ...r, date: (e.target as HTMLInputElement).value } : r)),
                )
              }
            />
            <s-text-field
              type="time"
              label={idx === 0 ? "Start time" : undefined}
              value={row.time}
              onChange={(e) =>
                setDraftRows((rs) =>
                  rs.map((r, i) => (i === idx ? { ...r, time: (e.target as HTMLInputElement).value } : r)),
                )
              }
            />
            <s-button
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

function SessionRow({
  session,
  timezone,
}: {
  session: {
    id: string;
    sku: string;
    startsAt: string | Date;
    capacity: number;
    priceCents: number | null;
    cancelled: boolean;
    variantGid: string;
  };
  timezone: string;
}) {
  const iso = typeof session.startsAt === "string" ? session.startsAt : session.startsAt.toISOString();
  return (
    <s-stack direction="inline" gap="base">
      <s-text weight={session.cancelled ? undefined : "bold"} tone={session.cancelled ? "subdued" : undefined}>
        {formatSessionTitle(iso, timezone)}
      </s-text>
      <s-text tone="subdued">{session.capacity} seats</s-text>
      {session.priceCents != null && (
        <s-text tone="subdued">${(session.priceCents / 100).toFixed(2)}</s-text>
      )}
      <s-text tone="subdued">{session.sku}</s-text>
      <Form method="post">
        <input type="hidden" name="intent" value="remove-session" />
        <input type="hidden" name="sessionId" value={session.id} />
        <s-button type="submit" tone="critical" variant="tertiary">
          Remove
        </s-button>
      </Form>
    </s-stack>
  );
}

function DangerZone({ busy }: { busy: boolean }) {
  return (
    <s-section heading="Archive">
      <s-paragraph>
        Archiving hides this class from the list. Variants in Shopify are not
        removed — manage them in Shopify if you need to delist the product.
      </s-paragraph>
      <Form method="post">
        <input type="hidden" name="intent" value="archive-class" />
        <s-button type="submit" tone="critical" loading={busy ? true : undefined}>
          Archive class
        </s-button>
      </Form>
    </s-section>
  );
}

function productNumericId(gid: string): string {
  // gid://shopify/Product/12345 -> 12345
  return gid.split("/").pop() ?? "";
}

