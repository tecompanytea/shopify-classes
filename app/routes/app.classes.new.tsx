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
import { getOrCreateShopSettings } from "../lib/settings.server";
import { SUPPORTED_TIMEZONES } from "../lib/timezones";
import { formatSessionTitle, generateSessionSku } from "../lib/sku";
import { ensureSessionDateOption } from "../.server/shopify/products";
import {
  createSessionVariants,
  setInventoryAtLocation,
  type SessionDraft,
} from "../.server/shopify/variants";
import {
  getShopCurrency,
  listShopifyLocations,
  type ShopifyLocation,
} from "../.server/shopify/locations";

type WizardLoader = {
  defaults: {
    timezone: string;
    durationMin: number;
    capacity: number;
    locationId: string | null;
  };
  locations: { id: string; name: string; timezone: string }[];
  shopifyLocations: ShopifyLocation[];
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<WizardLoader> => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);

  const [locations, shopifyLocations] = await Promise.all([
    db.location.findMany({
      where: { shop: session.shop, archived: false },
      orderBy: { name: "asc" },
    }),
    listShopifyLocations(admin),
  ]);

  return {
    defaults: {
      timezone: settings.defaultTimezone,
      durationMin: settings.defaultDurationMin,
      capacity: settings.defaultCapacity,
      locationId: settings.defaultLocationId,
    },
    locations: locations.map((l) => ({ id: l.id, name: l.name, timezone: l.timezone })),
    shopifyLocations,
  };
};

type ActionData = { error: string } | { ok: true };

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const productGid = String(formData.get("productGid") ?? "");
  const productTitle = String(formData.get("productTitle") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  const shopifyLocationGid = String(formData.get("shopifyLocationGid") ?? "");
  const timezone = String(formData.get("timezone") ?? "America/Los_Angeles");
  const durationMin = Number(formData.get("durationMin") ?? 60);
  const defaultCapacity = Number(formData.get("defaultCapacity") ?? 12);
  const defaultPriceCents = formData.get("defaultPriceCents")
    ? Number(formData.get("defaultPriceCents"))
    : null;
  const sessionsJson = String(formData.get("sessions") ?? "[]");

  if (!productGid) return { error: "Pick a product to continue." };
  if (!shopifyLocationGid) {
    return { error: "Pick a Shopify location for inventory." };
  }

  let parsedSessions: Array<{
    startsAt: string;
    capacity?: number;
    priceCents?: number | null;
  }>;
  try {
    parsedSessions = JSON.parse(sessionsJson);
  } catch {
    return { error: "Couldn't read the sessions list." };
  }
  if (!Array.isArray(parsedSessions) || parsedSessions.length === 0) {
    return { error: "Add at least one session." };
  }

  // Build drafts (variant input + persistence rows)
  const drafts: SessionDraft[] = parsedSessions.map((s) => {
    const startsAt = DateTime.fromISO(s.startsAt, { zone: timezone });
    const endsAt = startsAt.plus({ minutes: durationMin });
    return {
      startsAt: startsAt.toJSDate(),
      endsAt: endsAt.toJSDate(),
      timezone,
      capacity: s.capacity ?? defaultCapacity,
      priceCents: s.priceCents ?? defaultPriceCents,
      sku: generateSessionSku(productTitle, startsAt.toISO()!, timezone),
      displayName: formatSessionTitle(startsAt.toISO()!, timezone),
    };
  });

  // 1) Make sure the product has a "Session" option to attach variant values to.
  await ensureSessionDateOption(admin, productGid);

  // 2) Bulk-create the variants.
  const currencyCode = await getShopCurrency(admin);
  const created = await createSessionVariants(admin, {
    productGid,
    drafts,
    currencyCode,
  });

  // 3) Activate inventory at the picked Shopify location and set quantity to capacity.
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

  // 4) Upsert ClassProduct + persist ClassSession rows
  const classProduct = await db.classProduct.upsert({
    where: { shop_productGid: { shop: session.shop, productGid } },
    create: {
      shop: session.shop,
      productGid,
      title: productTitle,
      status: "active",
      locationId: locationId || null,
      timezone,
      durationMin,
      defaultCapacity,
      defaultPriceCents,
      publishedAt: new Date(),
    },
    update: {
      title: productTitle,
      status: "active",
      locationId: locationId || null,
      timezone,
      durationMin,
      defaultCapacity,
      defaultPriceCents,
      publishedAt: new Date(),
    },
  });

  await db.classSession.createMany({
    data: created.map((c, idx) => ({
      classProductId: classProduct.id,
      shop: session.shop,
      variantGid: c.variantGid,
      inventoryItemGid: c.inventoryItemGid,
      sku: c.sku,
      startsAt: drafts[idx].startsAt,
      endsAt: drafts[idx].endsAt,
      timezone,
      capacity: drafts[idx].capacity,
      priceCents: drafts[idx].priceCents ?? null,
    })),
    skipDuplicates: true,
  });

  return redirect(`/app/classes/${classProduct.id}`);
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

type PickedProduct = {
  id: string;
  title: string;
  handle: string;
};

type SessionRow = {
  date: string; // YYYY-MM-DD
  time: string; // HH:MM (24h)
  capacity?: number;
  priceCents?: number;
};

export default function NewClassWizard() {
  const { defaults, locations, shopifyLocations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [locationId, setLocationId] = useState(defaults.locationId ?? "");
  const [shopifyLocationGid, setShopifyLocationGid] = useState(
    shopifyLocations[0]?.id ?? "",
  );
  const [timezone, setTimezone] = useState(defaults.timezone);
  const [durationMin, setDurationMin] = useState(defaults.durationMin);
  const [defaultCapacity, setDefaultCapacity] = useState(defaults.capacity);
  const [defaultPriceCents, setDefaultPriceCents] = useState<number | "">("");

  const todayIso = useMemo(
    () => DateTime.now().setZone(timezone).toFormat("yyyy-LL-dd"),
    [timezone],
  );
  const [sessions, setSessions] = useState<SessionRow[]>([{ date: todayIso, time: "15:00" }]);
  const sessionsPayload = useMemo(() => {
    return sessions
      .filter((s) => s.date && s.time)
      .map((s) => {
        const iso = DateTime.fromISO(`${s.date}T${s.time}`, { zone: timezone }).toISO();
        return {
          startsAt: iso,
          capacity: s.capacity ?? defaultCapacity,
          priceCents: s.priceCents ?? (defaultPriceCents === "" ? null : defaultPriceCents),
        };
      });
  }, [sessions, timezone, defaultCapacity, defaultPriceCents]);

  const pickProduct = async () => {
    // App Bridge ResourcePicker, available globally inside embedded apps.
    const result = await (window as unknown as {
      shopify: {
        resourcePicker: (opts: {
          type: "product";
          multiple?: boolean;
        }) => Promise<{ id: string; title: string; handle: string }[] | undefined>;
      };
    }).shopify.resourcePicker({ type: "product", multiple: false });

    const first = Array.isArray(result) ? result[0] : undefined;
    if (first) {
      setPicked({ id: first.id, title: first.title, handle: first.handle });
    }
  };

  return (
    <s-page heading="New class" back-href="/app/classes">
      <s-section heading={`Step ${step} of 4`}>
        <Stepper step={step} />
      </s-section>

      {step === 1 && (
        <s-section heading="Pick the product">
          <s-paragraph>
            Each class is a Shopify product. Pick an existing one or create it first
            in Shopify, then come back here.
          </s-paragraph>
          {picked ? (
            <s-stack direction="block" gap="base">
              <s-stack direction="inline" gap="base">
                <s-badge tone="success">Selected</s-badge>
                <s-text><strong>{picked.title}</strong></s-text>
              </s-stack>
              <s-stack direction="inline" gap="base">
                <s-button onClick={pickProduct}>Change product</s-button>
                <s-button variant="primary" onClick={() => setStep(2)}>
                  Continue
                </s-button>
              </s-stack>
            </s-stack>
          ) : (
            <s-button variant="primary" onClick={pickProduct}>
              Pick a Shopify product
            </s-button>
          )}
        </s-section>
      )}

      {step === 2 && (
        <s-section heading="Defaults">
          <s-paragraph>
            These apply to every session you generate next. You can override per
            session in step 3.
          </s-paragraph>
          <s-stack direction="block" gap="base">
            <s-select
              label="Timezone"
              value={timezone}
              onChange={(e) => setTimezone((e.target as HTMLSelectElement).value)}
            >
              {SUPPORTED_TIMEZONES.map((tz) => (
                <s-option key={tz.value} value={tz.value}>
                  {tz.label}
                </s-option>
              ))}
            </s-select>

            <s-select
              label="Location (display)"
              details="Used on the product page and confirmation email. Manage in Locations."
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

            <s-select
              label="Shopify inventory location"
              details="Where seat inventory is tracked. Required for checkout."
              value={shopifyLocationGid}
              onChange={(e) => setShopifyLocationGid((e.target as HTMLSelectElement).value)}
            >
              {shopifyLocations.map((l) => (
                <s-option key={l.id} value={l.id}>
                  {l.name}
                </s-option>
              ))}
            </s-select>

            <s-number-field
              label="Duration (minutes)"
              value={String(durationMin)}
              onChange={(e) => setDurationMin(Number((e.target as HTMLInputElement).value) || 0)}
            />
            <s-number-field
              label="Default capacity (seats)"
              value={String(defaultCapacity)}
              onChange={(e) => setDefaultCapacity(Number((e.target as HTMLInputElement).value) || 0)}
            />
            <s-number-field
              label="Default price"
              details="Optional. Leave blank to keep the product's existing price."
              step={0.01}
              value={defaultPriceCents === "" ? "" : (defaultPriceCents / 100).toString()}
              onChange={(e) => {
                const v = (e.target as HTMLInputElement).value;
                setDefaultPriceCents(v === "" ? "" : Math.round(Number(v) * 100));
              }}
            />
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-button onClick={() => setStep(1)}>Back</s-button>
            <s-button variant="primary" onClick={() => setStep(3)}>
              Continue
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 3 && (
        <s-section heading="Sessions">
          <s-paragraph>
            Each row becomes a Shopify variant on this product. Inventory equals
            capacity. SKU is generated from the product name and start time.
          </s-paragraph>

          <s-stack direction="block" gap="base">
            {sessions.map((row, idx) => (
              <s-stack key={idx} direction="inline" gap="base">
                <s-date-field
                  label={idx === 0 ? "Date" : undefined}
                  value={row.date}
                  onChange={(e) => updateRow(setSessions, idx, { date: (e.target as HTMLInputElement).value })}
                />
                <s-text-field
                  label={idx === 0 ? "Start time" : undefined}
                  placeholder="15:00"
                  value={row.time}
                  onChange={(e) => updateRow(setSessions, idx, { time: (e.target as HTMLInputElement).value })}
                />
                <s-number-field
                  label={idx === 0 ? "Capacity" : undefined}
                  placeholder={String(defaultCapacity)}
                  value={row.capacity != null ? String(row.capacity) : ""}
                  onChange={(e) =>
                    updateRow(setSessions, idx, {
                      capacity: (e.target as HTMLInputElement).value
                        ? Number((e.target as HTMLInputElement).value)
                        : undefined,
                    })
                  }
                />
                <s-number-field
                  label={idx === 0 ? "Price override" : undefined}
                  placeholder={defaultPriceCents === "" ? "Product price" : (defaultPriceCents / 100).toFixed(2)}
                  step={0.01}
                  value={row.priceCents != null ? (row.priceCents / 100).toString() : ""}
                  onChange={(e) => {
                    const v = (e.target as HTMLInputElement).value;
                    updateRow(setSessions, idx, {
                      priceCents: v === "" ? undefined : Math.round(Number(v) * 100),
                    });
                  }}
                />
                <s-button
                  onClick={() => setSessions((rs) => rs.filter((_, i) => i !== idx))}
                  disabled={sessions.length === 1}
                >
                  Remove
                </s-button>
              </s-stack>
            ))}

            <s-button
              onClick={() =>
                setSessions((rs) => [
                  ...rs,
                  { date: rs[rs.length - 1]?.date ?? todayIso, time: rs[rs.length - 1]?.time ?? "15:00" },
                ])
              }
            >
              Add session
            </s-button>
          </s-stack>

          <s-stack direction="inline" gap="base">
            <s-button onClick={() => setStep(2)}>Back</s-button>
            <s-button variant="primary" onClick={() => setStep(4)}>
              Review
            </s-button>
          </s-stack>
        </s-section>
      )}

      {step === 4 && (
        <s-section heading="Review">
          <s-stack direction="block" gap="base">
            <Row label="Product" value={picked?.title ?? "—"} />
            <Row label="Timezone" value={timezone} />
            <Row label="Duration" value={`${durationMin} min`} />
            <Row label="Default capacity" value={`${defaultCapacity} seats`} />
            <Row
              label="Default price"
              value={defaultPriceCents === "" ? "Product price" : `$${(defaultPriceCents / 100).toFixed(2)}`}
            />
            <Row
              label="Display location"
              value={locations.find((l) => l.id === locationId)?.name ?? "—"}
            />
            <Row
              label="Inventory location"
              value={shopifyLocations.find((l) => l.id === shopifyLocationGid)?.name ?? "—"}
            />
            <Row label="Sessions" value={`${sessionsPayload.length}`} />

            <ul style={{ paddingLeft: "1rem", margin: 0 }}>
              {sessionsPayload.map((s, i) => (
                <li key={i}>
                  {formatSessionTitle(s.startsAt!, timezone)} · {s.capacity} seats
                  {s.priceCents != null ? ` · $${(s.priceCents / 100).toFixed(2)}` : ""}
                </li>
              ))}
            </ul>
          </s-stack>

          {actionData && "error" in actionData && (
            <s-banner tone="critical">{actionData.error}</s-banner>
          )}

          <Form method="post">
            <input type="hidden" name="productGid" value={picked?.id ?? ""} />
            <input type="hidden" name="productTitle" value={picked?.title ?? ""} />
            <input type="hidden" name="locationId" value={locationId} />
            <input type="hidden" name="shopifyLocationGid" value={shopifyLocationGid} />
            <input type="hidden" name="timezone" value={timezone} />
            <input type="hidden" name="durationMin" value={durationMin} />
            <input type="hidden" name="defaultCapacity" value={defaultCapacity} />
            <input
              type="hidden"
              name="defaultPriceCents"
              value={defaultPriceCents === "" ? "" : defaultPriceCents}
            />
            <input type="hidden" name="sessions" value={JSON.stringify(sessionsPayload)} />

            <s-stack direction="inline" gap="base">
              <s-button onClick={() => setStep(3)} disabled={submitting}>
                Back
              </s-button>
              <s-button type="submit" variant="primary" loading={submitting ? true : undefined}>
                Create class & sessions
              </s-button>
            </s-stack>
          </Form>
        </s-section>
      )}
    </s-page>
  );
}

function updateRow(
  set: React.Dispatch<React.SetStateAction<SessionRow[]>>,
  idx: number,
  patch: Partial<SessionRow>,
) {
  set((rs) => rs.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <s-stack direction="inline" gap="base">
      <span style={{ minWidth: "12rem" }}>
        <s-text tone="neutral">{label}</s-text>
      </span>
      <s-text>{value}</s-text>
    </s-stack>
  );
}

function Stepper({ step }: { step: number }) {
  const labels = ["Product", "Defaults", "Sessions", "Review"];
  return (
    <s-stack direction="inline" gap="base">
      {labels.map((label, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        return (
          <s-stack key={label} direction="inline" gap="base">
            <s-badge tone={done ? "success" : active ? "info" : undefined}>{n}</s-badge>
            <s-text tone={active ? undefined : "neutral"}>{label}</s-text>
          </s-stack>
        );
      })}
    </s-stack>
  );
}
