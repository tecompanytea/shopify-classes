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
import { CLASS_TIMEZONE } from "../lib/class-config";
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
    durationMin: number;
    capacity: number;
    locationId: string | null;
  };
  locations: { id: string; name: string }[];
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
      durationMin: settings.defaultDurationMin,
      capacity: settings.defaultCapacity,
      locationId: settings.defaultLocationId,
    },
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    shopifyLocations,
  };
};

type ActionData = { error: string } | { ok: true };
type ProductMode = "with-product" | "without-product";

export const action = async ({ request }: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const eventName = String(formData.get("eventName") ?? "").trim();
  const productMode = String(formData.get("productMode") ?? "with-product") as ProductMode;
  const productGid = String(formData.get("productGid") ?? "");
  const productTitle = String(formData.get("productTitle") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  const shopifyLocationGid = String(formData.get("shopifyLocationGid") ?? "");
  const durationMin = Number(formData.get("durationMin") ?? 60);
  const defaultCapacity = Number(formData.get("defaultCapacity") ?? 12);
  const notes = String(formData.get("notes") ?? "").trim();
  const tags = normalizeTags(String(formData.get("tags") ?? ""));
  const sessionsJson = String(formData.get("sessions") ?? "[]");
  const eventTitle = eventName || productTitle;

  if (!eventTitle) return { error: "Enter an event name to continue." };
  if (productMode !== "with-product") {
    return { error: "Events without products are not ready to create yet." };
  }
  if (!productGid) return { error: "Pick a product to continue." };
  if (!shopifyLocationGid) {
    return { error: "Pick a Shopify location for inventory." };
  }

  let parsedSessions: Array<{
    startsAt: string;
    capacity?: number;
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
    const startsAt = DateTime.fromISO(s.startsAt, { zone: CLASS_TIMEZONE });
    const endsAt = startsAt.plus({ minutes: durationMin });
    return {
      startsAt: startsAt.toJSDate(),
      endsAt: endsAt.toJSDate(),
      timezone: CLASS_TIMEZONE,
      capacity: s.capacity ?? defaultCapacity,
      sku: generateSessionSku(eventTitle, startsAt.toISO()!, CLASS_TIMEZONE),
      displayName: formatSessionTitle(startsAt.toISO()!, CLASS_TIMEZONE),
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
      title: eventTitle,
      status: "active",
      locationId: locationId || null,
      timezone: CLASS_TIMEZONE,
      durationMin,
      defaultCapacity,
      defaultPriceCents: null,
      notes: notes || null,
      tags: tags || null,
      publishedAt: new Date(),
    },
    update: {
      title: eventTitle,
      status: "active",
      locationId: locationId || null,
      timezone: CLASS_TIMEZONE,
      durationMin,
      defaultCapacity,
      defaultPriceCents: null,
      notes: notes || null,
      tags: tags || null,
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
      timezone: CLASS_TIMEZONE,
      capacity: drafts[idx].capacity,
      priceCents: null,
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
};

export default function NewClassWizard() {
  const { defaults, locations, shopifyLocations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const [eventName, setEventName] = useState("");
  const [productMode, setProductMode] = useState<ProductMode>("with-product");
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [locationId, setLocationId] = useState(defaults.locationId ?? "");
  const [shopifyLocationGid, setShopifyLocationGid] = useState(
    shopifyLocations[0]?.id ?? "",
  );
  const [durationMin, setDurationMin] = useState(defaults.durationMin);
  const [defaultCapacity, setDefaultCapacity] = useState(defaults.capacity);
  const [notes, setNotes] = useState("");
  const [tags, setTags] = useState("");

  const todayIso = useMemo(
    () => DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd"),
    [],
  );
  const [sessions, setSessions] = useState<SessionRow[]>([{ date: todayIso, time: "15:00" }]);
  const sessionsPayload = useMemo(() => {
    return sessions
      .filter((s) => s.date && s.time)
      .map((s) => {
        const iso = DateTime.fromISO(`${s.date}T${s.time}`, { zone: CLASS_TIMEZONE }).toISO();
        return {
          startsAt: iso,
          capacity: s.capacity ?? defaultCapacity,
        };
      });
  }, [sessions, defaultCapacity]);

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
      setEventName((current) => current || first.title);
    }
  };

  const eventTitle = eventName.trim();
  const withProduct = productMode === "with-product";
  const displayLocationName =
    locations.find((l) => l.id === locationId)?.name ?? "—";
  const summaryRows = [
    { label: "Event name", value: eventTitle || "—" },
    { label: "Product", value: withProduct ? picked?.title ?? "—" : "No product" },
    { label: "Duration", value: `${durationMin} min` },
    { label: "Capacity", value: `${defaultCapacity} seats` },
    { label: "Location", value: displayLocationName },
  ];

  return (
    <s-page heading="New event" back-href="/app/classes">
      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <s-stack direction="block" gap="base">
        <s-grid gridTemplateColumns="minmax(0, 2fr) minmax(280px, 1fr)" gap="base">
          <s-stack direction="block" gap="base">
            <s-section heading="Event name">
              <s-text-field
                label="Event name"
                labelAccessibilityVisibility="exclusive"
                placeholder="Eg. Tea tasting"
                details="Enter a name to identify this event."
                value={eventName}
                onChange={(e) => setEventName((e.target as HTMLInputElement).value)}
              />
            </s-section>

            <s-section accessibilityLabel="Product connection">
              <s-stack direction="block" gap="base">
                <s-choice-list
                  label="Product connection"
                  labelAccessibilityVisibility="exclusive"
                  values={[productMode]}
                  onChange={(e) => {
                    const [value] = (e.currentTarget as HTMLElement & { values?: string[] }).values ?? [];
                    setProductMode(value === "without-product" ? "without-product" : "with-product");
                  }}
                >
                  <s-choice value="with-product">Create event with product</s-choice>
                  <s-choice value="without-product">Create event without product</s-choice>
                </s-choice-list>

                {withProduct && (
                  <s-stack direction="block" gap="base">
                    <s-paragraph>
                      Link this event to a product to enable pricing and payment collection.
                    </s-paragraph>
                    {picked ? (
                      <s-stack direction="block" gap="base">
                        <s-stack direction="inline" gap="base">
                          <s-badge tone="success">Selected</s-badge>
                          <s-text type="strong">{picked.title}</s-text>
                        </s-stack>
                        <s-button type="button" onClick={pickProduct}>Change product</s-button>
                      </s-stack>
                    ) : (
                      <s-button type="button" variant="primary" onClick={pickProduct}>
                        Add product
                      </s-button>
                    )}
                  </s-stack>
                )}
              </s-stack>
            </s-section>

            <s-section heading="Defaults">
              <s-paragraph>
                These apply to every session. Price comes from the selected Shopify product.
              </s-paragraph>
              <s-stack direction="block" gap="base">
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
              </s-stack>
            </s-section>

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
                    <s-button
                      type="button"
                      onClick={() => setSessions((rs) => rs.filter((_, i) => i !== idx))}
                      disabled={sessions.length === 1}
                    >
                      Remove
                    </s-button>
                  </s-stack>
                ))}

                <s-button
                  type="button"
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
            </s-section>
          </s-stack>

          <s-stack direction="block" gap="base">
            <s-section heading="Notes">
              <s-text-area
                label="Notes"
                labelAccessibilityVisibility="exclusive"
                placeholder="No notes"
                rows={3}
                value={notes}
                onChange={(e) => setNotes((e.target as HTMLTextAreaElement).value)}
              />
            </s-section>

            <s-section heading="Tags">
              <s-text-field
                label="Tags"
                labelAccessibilityVisibility="exclusive"
                value={tags}
                onChange={(e) => setTags((e.target as HTMLInputElement).value)}
              />
            </s-section>
          </s-stack>
        </s-grid>

        <s-section heading="Summary">
          <s-stack direction="block" gap="base">
            <s-box border="base" borderRadius="base" padding="base">
              <s-stack direction="block" gap="base">
                {summaryRows.map((row) => (
                  <s-grid
                    key={row.label}
                    gridTemplateColumns="minmax(0, 1fr) minmax(0, 2fr)"
                    gap="base"
                  >
                    <s-text>{row.label}</s-text>
                    <s-text>{row.value}</s-text>
                  </s-grid>
                ))}
              </s-stack>
            </s-box>

            <Form method="post">
              <input type="hidden" name="eventName" value={eventTitle} />
              <input type="hidden" name="productMode" value={productMode} />
              <input type="hidden" name="productGid" value={picked?.id ?? ""} />
              <input type="hidden" name="productTitle" value={picked?.title ?? ""} />
              <input type="hidden" name="locationId" value={locationId} />
              <input type="hidden" name="shopifyLocationGid" value={shopifyLocationGid} />
              <input type="hidden" name="durationMin" value={durationMin} />
              <input type="hidden" name="defaultCapacity" value={defaultCapacity} />
              <input type="hidden" name="notes" value={notes} />
              <input type="hidden" name="tags" value={tags} />
              <input type="hidden" name="sessions" value={JSON.stringify(sessionsPayload)} />

              <s-box paddingBlockStart="base">
                <s-grid justifyItems="end">
                  <s-button
                    type="submit"
                    variant="primary"
                    loading={submitting ? true : undefined}
                    disabled={
                      !eventTitle ||
                      !withProduct ||
                      !picked ||
                      !shopifyLocationGid ||
                      sessionsPayload.length === 0 ||
                      submitting
                    }
                  >
                    Create event
                  </s-button>
                </s-grid>
              </s-box>
            </Form>
          </s-stack>
        </s-section>
      </s-stack>
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

function normalizeTags(value: string): string | null {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags.join(", ") : null;
}
