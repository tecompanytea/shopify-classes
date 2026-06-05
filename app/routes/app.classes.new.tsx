import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useFetcher,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/settings.server";
import {
  CLASS_TIMEZONE,
  DEFAULT_CLASS_CAPACITY,
  DEFAULT_CLASS_START_TIME,
} from "../lib/class-config";
import { allocateClassSessionSkus } from "../lib/class-skus.server";
import { formatSessionTitle } from "../lib/sku";
import {
  normalizeSessionTime,
  SESSION_TIME_OPTIONS,
  sessionTimeLabel,
} from "../lib/session-time-options";
import { ensureSessionDateOption } from "../.server/shopify/products";
import {
  createSessionVariants,
  setInventoryAtLocation,
  updateVariantSkus,
  type SessionDraft,
} from "../.server/shopify/variants";
import {
  getShopCurrency,
  listShopifyLocations,
  type ShopifyLocation,
} from "../.server/shopify/locations";
import type { ProductVariantsResult } from "./app.api.product-variants";

type WizardLoader = {
  defaults: {
    startTime: string;
    capacity: number;
    locationId: string | null;
  };
  locations: { id: string; name: string }[];
  shopifyLocations: ShopifyLocation[];
};

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<WizardLoader> => {
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
      startTime: settings.defaultStartTime ?? DEFAULT_CLASS_START_TIME,
      capacity: settings.defaultCapacity,
      locationId: settings.defaultLocationId,
    },
    locations: locations.map((l) => ({ id: l.id, name: l.name })),
    shopifyLocations,
  };
};

type ActionData = { error: string } | { ok: true };
type IncomingSession = {
  startsAt: string;
  capacity?: number;
  // Present when adopting an existing variant instead of creating a new one.
  variantGid?: string;
  inventoryItemGid?: string | null;
  sku?: string | null;
};

export const action = async ({
  request,
}: ActionFunctionArgs): Promise<ActionData | Response> => {
  const { session, admin } = await authenticate.admin(request);
  const formData = await request.formData();

  const eventName = String(formData.get("eventName") ?? "").trim();
  const productGid = String(formData.get("productGid") ?? "");
  const productTitle = String(formData.get("productTitle") ?? "");
  const locationId = String(formData.get("locationId") ?? "");
  const shopifyLocationGid = String(formData.get("shopifyLocationGid") ?? "");
  const defaultStartTime = normalizeSessionTime(
    formData.get("defaultStartTime"),
    DEFAULT_CLASS_START_TIME,
  );
  const defaultCapacity = Number(
    formData.get("defaultCapacity") ?? DEFAULT_CLASS_CAPACITY,
  );
  const notes = String(formData.get("notes") ?? "").trim();
  const tags = normalizeTags(String(formData.get("tags") ?? ""));
  const sessionsJson = String(formData.get("sessions") ?? "[]");
  const eventTitle = eventName || productTitle;

  if (!eventTitle) return { error: "Enter an event name to continue." };
  if (!productGid) return { error: "Pick a product to continue." };

  let parsedSessions: IncomingSession[];
  try {
    parsedSessions = JSON.parse(sessionsJson);
  } catch {
    return { error: "Couldn't read the sessions list." };
  }
  if (!Array.isArray(parsedSessions) || parsedSessions.length === 0) {
    return { error: "Add at least one session." };
  }

  // Rows that carry a variantGid adopt an existing variant; rows without one
  // are brand-new dates we create on the product.
  const toLink = parsedSessions.filter((s) => s.variantGid);
  const toCreate = parsedSessions.filter((s) => !s.variantGid);
  const allocatedSkus = await allocateClassSessionSkus(
    db,
    session.shop,
    parsedSessions.length,
  );
  let skuIndex = 0;

  // Only creating fresh variants needs an inventory location (we set seats on
  // them). Adopting existing variants leaves their inventory untouched.
  if (toCreate.length > 0 && !shopifyLocationGid) {
    return { error: "No Shopify inventory location is available." };
  }

  const sessionRows: Array<{
    variantGid: string;
    inventoryItemGid: string | null;
    sku: string;
    startsAt: Date;
    capacity: number;
  }> = [];

  // 1) Create new variants for any brand-new dates.
  if (toCreate.length > 0) {
    const drafts: SessionDraft[] = toCreate.map((s) => {
      const startsAt = DateTime.fromISO(s.startsAt, { zone: CLASS_TIMEZONE });
      return {
        startsAt: startsAt.toJSDate(),
        timezone: CLASS_TIMEZONE,
        capacity: s.capacity ?? defaultCapacity,
        sku: allocatedSkus[skuIndex++],
        displayName: formatSessionTitle(startsAt.toISO()!, CLASS_TIMEZONE),
      };
    });

    let created: Awaited<ReturnType<typeof createSessionVariants>>;
    try {
      const option = await ensureSessionDateOption(admin, productGid);
      if (!option)
        return { error: "Couldn't prepare the product date option." };
      const currencyCode = await getShopCurrency(admin);
      created = await createSessionVariants(admin, {
        productGid,
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

    created.forEach((c, idx) => {
      sessionRows.push({
        variantGid: c.variantGid,
        inventoryItemGid: c.inventoryItemGid,
        sku: c.sku,
        startsAt: drafts[idx].startsAt,
        capacity: drafts[idx].capacity,
      });
    });
  }

  // 2) Adopt existing variants by linking them and normalizing their SKUs.
  const linkedVariantSkuUpdates: Array<{ variantId: string; sku: string }> = [];
  for (const s of toLink) {
    const startsAt = DateTime.fromISO(s.startsAt, { zone: CLASS_TIMEZONE });
    const sku = allocatedSkus[skuIndex++];
    linkedVariantSkuUpdates.push({ variantId: s.variantGid!, sku });
    sessionRows.push({
      variantGid: s.variantGid!,
      inventoryItemGid: s.inventoryItemGid ?? null,
      sku,
      startsAt: startsAt.toJSDate(),
      capacity: s.capacity ?? defaultCapacity,
    });
  }

  if (linkedVariantSkuUpdates.length > 0) {
    try {
      await updateVariantSkus(admin, {
        productGid,
        variants: linkedVariantSkuUpdates,
      });
    } catch (error) {
      return { error: shopifyMutationError(error) };
    }
  }

  // 3) Upsert ClassProduct + persist ClassSession rows.
  const classProduct = await db.classProduct.upsert({
    where: { shop_productGid: { shop: session.shop, productGid } },
    create: {
      shop: session.shop,
      productGid,
      title: eventTitle,
      productTitle: productTitle || null,
      status: "active",
      locationId: locationId || null,
      timezone: CLASS_TIMEZONE,
      defaultStartTime,
      defaultCapacity,
      defaultPriceCents: null,
      notes: notes || null,
      tags: tags || null,
      publishedAt: new Date(),
    },
    update: {
      title: eventTitle,
      productTitle: productTitle || null,
      status: "active",
      locationId: locationId || null,
      timezone: CLASS_TIMEZONE,
      defaultStartTime,
      defaultCapacity,
      defaultPriceCents: null,
      notes: notes || null,
      tags: tags || null,
      publishedAt: new Date(),
    },
  });

  await db.classSession.createMany({
    data: sessionRows.map((r) => ({
      classProductId: classProduct.id,
      shop: session.shop,
      variantGid: r.variantGid,
      inventoryItemGid: r.inventoryItemGid,
      sku: r.sku,
      startsAt: r.startsAt,
      timezone: CLASS_TIMEZONE,
      capacity: r.capacity,
      priceCents: null,
    })),
    skipDuplicates: true,
  });

  return redirect(`/app/classes/${classProduct.id}`);
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

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
  // Present when this row adopts an existing product variant.
  variantGid?: string;
  inventoryItemGid?: string | null;
  sku?: string | null;
  originalTitle?: string;
};

export default function NewClassWizard() {
  const { defaults, locations, shopifyLocations } =
    useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  const [eventName, setEventName] = useState("");
  const [picked, setPicked] = useState<PickedProduct | null>(null);
  const [locationId, setLocationId] = useState(defaults.locationId ?? "");
  const shopifyLocationGid = shopifyLocations[0]?.id ?? "";
  const [defaultCapacity, setDefaultCapacity] = useState(defaults.capacity);
  const [tags, setTags] = useState("");
  const [defaultTime, setDefaultTime] = useState(defaults.startTime);
  const variantsFetcher = useFetcher<ProductVariantsResult>();
  const adoptedProductRef = useRef<string | null>(null);

  const todayIso = useMemo(
    () => DateTime.now().setZone(CLASS_TIMEZONE).toFormat("yyyy-LL-dd"),
    [],
  );
  const [sessions, setSessions] = useState<SessionRow[]>([
    { date: todayIso, time: defaults.startTime },
  ]);
  const productPickerOpen = useRef(false);
  const sessionsPayload = useMemo(() => {
    return sessions
      .filter((s) => s.date && s.time)
      .map((s) => {
        const iso = DateTime.fromISO(`${s.date}T${s.time}`, {
          zone: CLASS_TIMEZONE,
        }).toISO();
        return {
          startsAt: iso,
          capacity: s.capacity ?? defaultCapacity,
          ...(s.variantGid
            ? {
                variantGid: s.variantGid,
                inventoryItemGid: s.inventoryItemGid ?? null,
                sku: s.sku ?? null,
              }
            : {}),
        };
      });
  }, [sessions, defaultCapacity]);

  // When a product is picked, pull its existing date-like variants and prefill
  // the session rows so the merchant can adopt them instead of retyping.
  useEffect(() => {
    if (variantsFetcher.state !== "idle" || !variantsFetcher.data) return;
    const productGid = picked?.id;
    if (!productGid || adoptedProductRef.current === productGid) return;
    adoptedProductRef.current = productGid;

    const candidates = variantsFetcher.data.candidates;
    if (candidates.length === 0) {
      // No dated variants — clear any adopt rows left from a previous product.
      setSessions((rs) =>
        rs.some((r) => r.variantGid)
          ? [{ date: todayIso, time: defaultTime }]
          : rs,
      );
      return;
    }

    setSessions(
      candidates.map((c) => ({
        date: c.date ?? todayIso,
        time: defaultTime,
        capacity: c.inventoryQuantity ?? undefined,
        variantGid: c.variantGid,
        inventoryItemGid: c.inventoryItemGid,
        sku: c.sku,
        originalTitle: c.title,
      })),
    );
  }, [
    variantsFetcher.state,
    variantsFetcher.data,
    picked?.id,
    todayIso,
    defaultTime,
  ]);

  const pickProduct = async (initialQuery = "") => {
    if (productPickerOpen.current) return;

    productPickerOpen.current = true;

    // App Bridge ResourcePicker, available globally inside embedded apps.
    try {
      const query = initialQuery.trim();
      const result = await (
        window as unknown as {
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
        }
      ).shopify.resourcePicker({
        type: "product",
        multiple: false,
        filter: { variants: true },
        ...(query ? { query } : {}),
      });

      const first = Array.isArray(result) ? result[0] : undefined;
      if (first) {
        setPicked(toPickedProduct(first));
        setEventName((current) => current || first.title);
        adoptedProductRef.current = null;
        variantsFetcher.load(
          `/app/api/product-variants?productGid=${encodeURIComponent(first.id)}`,
        );
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
  const createFormId = "new-event-create-form";
  const displayLocationName =
    locations.find((l) => l.id === locationId)?.name ?? "—";
  const sessionCount = sessionsPayload.length;
  const adopting = sessions.some((s) => s.variantGid);
  const hasNewSessions = sessions.some(
    (s) => s.date && s.time && !s.variantGid,
  );
  const readyToCreate = Boolean(
    eventTitle &&
    picked &&
    sessionsPayload.length > 0 &&
    (!hasNewSessions || shopifyLocationGid),
  );
  const canCreate = readyToCreate && !submitting;
  const summaryRows = [
    { label: "Name", value: eventTitle || "—" },
    {
      label: "Product",
      value: picked?.title ?? "—",
    },
    { label: "Default start time", value: sessionTimeLabel(defaultTime) },
    { label: "Capacity", value: `${defaultCapacity} seats` },
    { label: "Location", value: displayLocationName },
  ];

  function changeDefaultTime(value: string) {
    setDefaultTime(value);
    setSessions((rows) => rows.map((row) => ({ ...row, time: value })));
  }

  function submitCreateForm() {
    const form = document.getElementById(createFormId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  return (
    <s-page heading="New event">
      <s-link slot="breadcrumb-actions" href="/app/classes">
        Events
      </s-link>

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
          <s-stack
            direction="inline"
            justifyContent="space-between"
            alignItems="start"
          >
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

      <s-section heading="Internal event name *">
        <s-text-field
          label="Internal event name"
          labelAccessibilityVisibility="exclusive"
          placeholder="Eg. Tea tasting"
          details="Enter a name to identify this event."
          value={eventName}
          required
          onChange={(e) => setEventName((e.target as HTMLInputElement).value)}
        />
      </s-section>

      <s-section accessibilityLabel="Product connection">
        <s-grid
          gridTemplateColumns="1fr auto"
          gap="small-400"
          alignItems="stretch"
        >
          <s-search-field
            label="Search"
            labelAccessibilityVisibility="exclusive"
            placeholder="Search products"
            value=""
            onInput={openProductPickerFromSearch}
          />
          <s-button
            type="button"
            variant="secondary"
            onClick={() => pickProduct()}
          >
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
                  {picked.imageUrl ? (
                    <s-box inlineSize="60px">
                      <s-image
                        src={picked.imageUrl}
                        alt={picked.imageAlt}
                        aspectRatio="1/1"
                        objectFit="cover"
                        borderRadius="base"
                      />
                    </s-box>
                  ) : (
                    <s-thumbnail alt={picked.imageAlt} size="base" />
                  )}
                  <s-stack direction="block" gap="none">
                    <s-text type="strong">{picked.title}</s-text>
                    <s-text color="subdued">
                      {variantSelectionLabel(picked)}
                    </s-text>
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
                    onClick={() => {
                      setPicked(null);
                      adoptedProductRef.current = null;
                      setSessions([{ date: todayIso, time: defaultTime }]);
                    }}
                  />
                </s-stack>
              </s-stack>
            </s-box>
          </s-box>
        )}
      </s-section>

      <s-section heading="Schedule defaults">
        <s-stack direction="block" gap="base">
          <s-select
            label="Location"
            value={locationId}
            onChange={(e) =>
              setLocationId((e.target as HTMLSelectElement).value)
            }
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
              label="Default start time"
              icon="clock"
              value={defaultTime}
              onChange={(e) =>
                changeDefaultTime((e.target as HTMLSelectElement).value)
              }
            >
              {SESSION_TIME_OPTIONS.map((option) => (
                <s-option key={option.value} value={option.value}>
                  {option.label}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              label="Seats per session"
              value={String(defaultCapacity)}
              onChange={(e) =>
                setDefaultCapacity(
                  Number((e.target as HTMLInputElement).value) || 0,
                )
              }
            />
          </s-grid>
          <s-paragraph>Class price comes from the Shopify product.</s-paragraph>
        </s-stack>
      </s-section>

      <s-section heading={`Sessions · ${sessionCount}`}>
        <s-stack direction="block" gap="base">
          {picked && variantsFetcher.state !== "idle" ? (
            <s-text color="subdued">Checking for existing dates…</s-text>
          ) : adopting ? (
            <s-banner tone="info">
              Imported {sessions.filter((s) => s.variantGid).length} existing
              date{sessions.filter((s) => s.variantGid).length === 1 ? "" : "s"}{" "}
              from this product. Confirm dates, start time, and seats, then
              create. This links the existing variants, normalizes their SKUs,
              and will not change inventory.
            </s-banner>
          ) : (
            <s-paragraph>
              Each session becomes a Shopify variant on the selected product.
            </s-paragraph>
          )}

          {adopting && (
            <s-text color="subdued">
              Default start time applies to all imported sessions.
            </s-text>
          )}

          {sessions.map((row, idx) => (
            <s-stack key={idx} direction="block" gap="small-200">
              <s-grid
                gridTemplateColumns="minmax(0, 1fr) auto"
                gap="small-400"
                alignItems="end"
              >
                <s-grid
                  id={`new-session-fields-${idx}`}
                  gridTemplateColumns="repeat(auto-fit, minmax(220px, 1fr))"
                  gap="base"
                >
                  <s-date-field
                    label="Date"
                    placeholder="YYYY-MM-DD"
                    allow={`${todayIso}--`}
                    labelAccessibilityVisibility={
                      idx === 0 ? "visible" : "exclusive"
                    }
                    value={row.date}
                    onChange={(e) => {
                      const nextDate = (e.target as HTMLInputElement).value;
                      if (nextDate && nextDate < todayIso) return;
                      updateRow(setSessions, idx, { date: nextDate });
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
                      updateRow(setSessions, idx, {
                        time: (e.target as HTMLSelectElement).value,
                      })
                    }
                  >
                    {SESSION_TIME_OPTIONS.map((option) => (
                      <s-option key={option.value} value={option.value}>
                        {option.label}
                      </s-option>
                    ))}
                  </s-select>
                  <s-number-field
                    label="Seats per session"
                    labelAccessibilityVisibility={
                      idx === 0 ? "visible" : "exclusive"
                    }
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
                </s-grid>
                <s-button-group accessibilityLabel="Session row actions">
                  <s-button
                    slot="secondary-actions"
                    type="button"
                    tone="critical"
                    onClick={() =>
                      setSessions((rs) => rs.filter((_, i) => i !== idx))
                    }
                    disabled={sessions.length === 1}
                  >
                    Delete
                  </s-button>
                </s-button-group>
              </s-grid>
              {row.originalTitle && (
                <s-text color="subdued">
                  From variant: {row.originalTitle}
                </s-text>
              )}
            </s-stack>
          ))}

          {!adopting && (
            <s-button-group accessibilityLabel="Session actions">
              <s-button
                slot="secondary-actions"
                type="button"
                icon="plus"
                onClick={() =>
                  setSessions((rs) => [
                    ...rs,
                    {
                      date: rs[rs.length - 1]?.date ?? todayIso,
                      time: rs[rs.length - 1]?.time ?? defaultTime,
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

      <Form id={createFormId} method="post">
        <input type="hidden" name="eventName" value={eventTitle} />
        <input type="hidden" name="productGid" value={picked?.id ?? ""} />
        <input type="hidden" name="productTitle" value={picked?.title ?? ""} />
        <input type="hidden" name="locationId" value={locationId} />
        <input
          type="hidden"
          name="shopifyLocationGid"
          value={shopifyLocationGid}
        />
        <input type="hidden" name="defaultStartTime" value={defaultTime} />
        <input type="hidden" name="defaultCapacity" value={defaultCapacity} />
        <input type="hidden" name="tags" value={tags} />
        <input
          type="hidden"
          name="sessions"
          value={JSON.stringify(sessionsPayload)}
        />
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
  const image =
    product.images?.[0] ?? product.featuredImage ?? product.image ?? null;

  return {
    id: product.id,
    title: product.title,
    handle: product.handle,
    imageUrl:
      image?.src ??
      image?.url ??
      image?.originalSrc ??
      image?.transformedSrc ??
      null,
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
    return selected === 1
      ? "1 variant selected"
      : `${selected} variants selected`;
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

function shopifyMutationError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "Couldn't update the Shopify product.";
}
