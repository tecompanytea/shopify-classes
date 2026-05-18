import { useMemo, useRef, useState } from "react";
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
  imageUrl: string | null;
  imageAlt: string;
  selectedVariantCount: number | null;
  totalVariants: number | null;
};

type ResourcePickerImage = {
  src?: string;
  url?: string;
  originalSrc?: string;
  transformedSrc?: string;
  alt?: string | null;
  altText?: string | null;
};

type ResourcePickerProduct = {
  id: string;
  title: string;
  handle: string;
  images?: ResourcePickerImage[];
  image?: ResourcePickerImage | null;
  featuredImage?: ResourcePickerImage | null;
  totalVariants?: number;
  variants?: unknown[];
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
  const [tags, setTags] = useState("");

  const todayIso = useMemo(
    () => DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd"),
    [],
  );
  const [sessions, setSessions] = useState<SessionRow[]>([{ date: todayIso, time: "15:00" }]);
  const productPickerOpen = useRef(false);
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

  const pickProduct = async (initialQuery = "") => {
    if (productPickerOpen.current) return;

    productPickerOpen.current = true;

    // App Bridge ResourcePicker, available globally inside embedded apps.
    try {
      const query = initialQuery.trim();
      const result = await (window as unknown as {
        shopify: {
          resourcePicker: (opts: {
            type: "product";
            multiple?: boolean;
            query?: string;
            filter?: {
              variants?: boolean;
            };
          }) => Promise<ResourcePickerProduct[] | undefined>;
        };
      }).shopify.resourcePicker({
        type: "product",
        multiple: false,
        filter: { variants: true },
        ...(query ? { query } : {}),
      });

      const first = Array.isArray(result) ? result[0] : undefined;
      if (first) {
        setPicked(toPickedProduct(first));
        setEventName((current) => current || first.title);
      }
    } finally {
      productPickerOpen.current = false;
    }
  };

  function openProductPickerFromSearch(event: Event) {
    const value = (event.currentTarget as HTMLInputElement).value;
    if (value.trim()) void pickProduct(value);
  }

  const eventTitle = eventName.trim();
  const withProduct = productMode === "with-product";
  const createFormId = "new-event-create-form";
  const displayLocationName =
    locations.find((l) => l.id === locationId)?.name ?? "—";
  const inventoryLocationName =
    shopifyLocations.find((l) => l.id === shopifyLocationGid)?.name ?? "—";
  const sessionCount = sessionsPayload.length;
  const readyToCreate = Boolean(
    eventTitle &&
      withProduct &&
      picked &&
      shopifyLocationGid &&
      sessionsPayload.length > 0,
  );
  const canCreate = readyToCreate && !submitting;
  const summaryRows = [
    { label: "Name", value: eventTitle || "—" },
    { label: "Product", value: withProduct ? picked?.title ?? "—" : "No product" },
    { label: "Duration", value: `${durationMin} min` },
    { label: "Capacity", value: `${defaultCapacity} seats` },
    { label: "Location", value: displayLocationName },
    { label: "Inventory", value: inventoryLocationName },
  ];

  function submitCreateForm() {
    const form = document.getElementById(createFormId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  return (
    <s-page heading="New event" back-href="/app/classes">
      <s-button
        slot="primary-action"
        variant="primary"
        loading={submitting ? true : undefined}
        disabled={!canCreate}
        onClick={submitCreateForm}
      >
        Create event
      </s-button>

      <s-section slot="aside" accessibilityLabel="Event summary">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" justifyContent="space-between" alignItems="start">
            <s-heading>Summary</s-heading>
            <s-badge>Draft</s-badge>
          </s-stack>

          <s-unordered-list>
            {summaryRows.map((row) => (
              <s-list-item key={row.label}>
                {row.label}: {row.value}
              </s-list-item>
            ))}
          </s-unordered-list>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Tags">
        <s-text-field
          label="Tags"
          labelAccessibilityVisibility="exclusive"
          details="Separate tags with commas."
          value={tags}
          onChange={(e) => setTags((e.target as HTMLInputElement).value)}
        />
      </s-section>

      {actionData && "error" in actionData && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <s-section heading="Event name">
        <s-text-field
          label="Event name"
          labelAccessibilityVisibility="exclusive"
          placeholder="Eg. Tea tasting"
          details="Enter a name to identify this service."
          value={eventName}
          required
          onChange={(e) => setEventName((e.target as HTMLInputElement).value)}
        />
      </s-section>

      <s-section accessibilityLabel="Product connection">
        <s-choice-list
          label="Payment option"
          labelAccessibilityVisibility="exclusive"
          values={[productMode]}
          onChange={(e) => {
            const [value] = (e.currentTarget as HTMLElement & { values?: string[] }).values ?? [];
            setProductMode(value === "without-product" ? "without-product" : "with-product");
          }}
        >
          <s-choice value="with-product">
            Create service with product
            <s-text slot="details">
              Link this service to a product to enable pricing and payment collection.
            </s-text>
          </s-choice>
        </s-choice-list>

        {withProduct && (
          <s-box paddingBlockStart="small-200">
            <s-grid gridTemplateColumns="1fr auto" gap="small-400" alignItems="stretch">
              <s-search-field
                label="Search"
                labelAccessibilityVisibility="exclusive"
                placeholder="Search products"
                value=""
                onInput={openProductPickerFromSearch}
              />
              <s-button type="button" variant="secondary" onClick={() => pickProduct()}>
                Add product
              </s-button>
            </s-grid>

            {picked && (
              <s-box paddingBlockStart="base">
                <s-box border="base" borderRadius="base" padding="base">
                  <s-stack
                    direction="inline"
                    alignItems="center"
                    justifyContent="space-between"
                    gap="base"
                  >
                    <s-stack direction="inline" alignItems="center" gap="base">
                      <s-thumbnail
                        src={picked.imageUrl ?? undefined}
                        alt={picked.imageAlt}
                        size="base"
                      />
                      <s-stack direction="block" gap="none">
                        <s-text type="strong">{picked.title}</s-text>
                        <s-text color="subdued">{variantSelectionLabel(picked)}</s-text>
                      </s-stack>
                    </s-stack>

                    <s-stack direction="inline" gap="small-400">
                      <s-button
                        type="button"
                        variant="tertiary"
                        icon="edit"
                        accessibilityLabel="Change product"
                        onClick={() => pickProduct()}
                      />
                      <s-button
                        type="button"
                        variant="tertiary"
                        tone="critical"
                        icon="delete"
                        accessibilityLabel="Remove product"
                        onClick={() => setPicked(null)}
                      />
                    </s-stack>
                  </s-stack>
                </s-box>
              </s-box>
            )}
          </s-box>
        )}

        <s-choice-list
          label="Service-only option"
          labelAccessibilityVisibility="exclusive"
          values={[productMode]}
          onChange={(e) => {
            const [value] = (e.currentTarget as HTMLElement & { values?: string[] }).values ?? [];
            setProductMode(value === "without-product" ? "without-product" : "with-product");
          }}
        >
          <s-choice value="without-product">
            Create service without product
            <s-text slot="details">
              Select this option when online payments are not required.
            </s-text>
          </s-choice>
        </s-choice-list>
      </s-section>

      <s-section heading="Schedule defaults">
        <s-paragraph>
          These apply to every session. Price comes from the selected Shopify product.
        </s-paragraph>
        <s-select
          label="Display location"
          details="Shown on the product page and confirmation email."
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
          label="Duration"
          suffix="minutes"
          value={String(durationMin)}
          onChange={(e) => setDurationMin(Number((e.target as HTMLInputElement).value) || 0)}
        />
        <s-number-field
          label="Default capacity"
          suffix="seats"
          value={String(defaultCapacity)}
          onChange={(e) => setDefaultCapacity(Number((e.target as HTMLInputElement).value) || 0)}
        />
      </s-section>

      <s-section heading={`Sessions · ${sessionCount}`}>
        <s-paragraph>
          Each session becomes a Shopify variant on the selected product. Inventory equals capacity.
        </s-paragraph>

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
              variant="tertiary"
              tone="critical"
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
      </s-section>

      <Form id={createFormId} method="post">
        <input type="hidden" name="eventName" value={eventTitle} />
        <input type="hidden" name="productMode" value={productMode} />
        <input type="hidden" name="productGid" value={picked?.id ?? ""} />
        <input type="hidden" name="productTitle" value={picked?.title ?? ""} />
        <input type="hidden" name="locationId" value={locationId} />
        <input type="hidden" name="shopifyLocationGid" value={shopifyLocationGid} />
        <input type="hidden" name="durationMin" value={durationMin} />
        <input type="hidden" name="defaultCapacity" value={defaultCapacity} />
        <input type="hidden" name="tags" value={tags} />
        <input type="hidden" name="sessions" value={JSON.stringify(sessionsPayload)} />
      </Form>
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

function toPickedProduct(product: ResourcePickerProduct): PickedProduct {
  const image = product.images?.[0] ?? product.featuredImage ?? product.image ?? null;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl: image?.src ?? image?.url ?? image?.originalSrc ?? image?.transformedSrc ?? null,
    imageAlt: image?.alt ?? image?.altText ?? `Image of ${product.title}`,
    selectedVariantCount: product.variants?.length ?? null,
    totalVariants: product.totalVariants ?? product.variants?.length ?? null,
  };
}

function variantSelectionLabel(product: PickedProduct): string {
  const selected = product.selectedVariantCount;
  const total = product.totalVariants;

  if (selected == null && total == null) return "Variants selected";
  if (selected == null) {
    return total === 1 ? "1 variant" : `${total} variants`;
  }
  if (total == null) {
    return selected === 1 ? "1 variant selected" : `${selected} variants selected`;
  }

  return `${selected} of ${total} ${total === 1 ? "variant" : "variants"} selected`;
}

function normalizeTags(value: string): string | null {
  const tags = value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
  return tags.length ? tags.join(", ") : null;
}
