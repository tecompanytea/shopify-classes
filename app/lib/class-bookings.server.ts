import type { ClassSession } from "@prisma/client";

import db from "../db.server";
import type { BookingRow } from "../.server/shopify/orders";

type SessionForBooking = ClassSession;

type ShopifyOrderWebhookPayload = {
  id?: number;
  admin_graphql_api_id?: string;
  name?: string;
  created_at?: string;
  email?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  customer?: {
    id?: number;
    admin_graphql_api_id?: string;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
    orders_count?: number | null;
    default_address?: {
      city?: string | null;
      province_code?: string | null;
      country?: string | null;
    } | null;
  } | null;
  line_items?: ShopifyOrderWebhookLineItem[];
};

type ShopifyOrderWebhookLineItem = {
  id?: number;
  admin_graphql_api_id?: string;
  title?: string | null;
  name?: string | null;
  quantity?: number;
  sku?: string | null;
  variant_id?: number | null;
  product_id?: number | null;
  variant_title?: string | null;
};

export async function upsertClassBookingsFromRows(
  shop: string,
  rows: BookingRow[],
  variantToSession: Map<string, SessionForBooking>,
) {
  for (const row of rows) {
    const classSession = variantToSession.get(row.variantId);
    if (!classSession) continue;

    await upsertClassBooking({
      shop,
      classSessionId: classSession.id,
      orderGid: row.orderId,
      orderName: row.orderName,
      lineItemGid: row.lineItemId,
      orderCreatedAt: new Date(row.createdAt),
      email: row.email,
      customerGid: row.customerId,
      customerName: row.customerName,
      customerOrdersCount: row.customerOrdersCount,
      customerLocation: row.customerLocation,
      financialStatus: row.financialStatus,
      fulfillmentStatus: row.fulfillmentStatus,
      variantGid: row.variantId,
      productGid: row.productId,
      sku: row.sku,
      quantity: row.quantity,
      title: row.title,
      variantTitle: row.variantTitle,
    });
  }
}

export async function upsertClassBookingsFromOrderWebhook(
  shop: string,
  payload: unknown,
) {
  const order = payload as ShopifyOrderWebhookPayload;
  const orderGid = order.admin_graphql_api_id ?? numericGid("Order", order.id);
  if (!orderGid || !order.name) return;

  const lineItems = order.line_items ?? [];
  if (lineItems.length === 0) return;

  const variantGids = lineItems
    .map((lineItem) => numericGid("ProductVariant", lineItem.variant_id))
    .filter(isPresent);
  const skus = lineItems
    .map((lineItem) => lineItem.sku?.trim())
    .filter(isPresent);
  if (variantGids.length === 0 && skus.length === 0) return;

  const sessions = await db.classSession.findMany({
    where: {
      shop,
      OR: [
        ...(variantGids.length > 0 ? [{ variantGid: { in: variantGids } }] : []),
        ...(skus.length > 0 ? [{ sku: { in: skus } }] : []),
      ],
    },
  });
  const byVariant = new Map(sessions.map((session) => [session.variantGid, session]));
  const bySku = new Map(sessions.map((session) => [session.sku, session]));

  const customer = order.customer ?? null;
  const customerName = [customer?.first_name, customer?.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();

  for (const lineItem of lineItems) {
    const variantGid = numericGid("ProductVariant", lineItem.variant_id);
    const sku = lineItem.sku?.trim() || null;
    const classSession =
      (variantGid ? byVariant.get(variantGid) : undefined) ??
      (sku ? bySku.get(sku) : undefined);
    if (!classSession) continue;

    const lineItemGid =
      lineItem.admin_graphql_api_id ?? numericGid("LineItem", lineItem.id);
    if (!lineItemGid) continue;

    await upsertClassBooking({
      shop,
      classSessionId: classSession.id,
      orderGid,
      orderName: order.name,
      lineItemGid,
      orderCreatedAt: order.created_at ? new Date(order.created_at) : new Date(),
      email: order.email ?? customer?.email ?? null,
      customerGid:
        customer?.admin_graphql_api_id ?? numericGid("Customer", customer?.id),
      customerName: customerName || null,
      customerOrdersCount: customer?.orders_count ?? null,
      customerLocation: customerLocation(customer?.default_address ?? null),
      financialStatus: normalizeStatus(order.financial_status),
      fulfillmentStatus: normalizeFulfillmentStatus(order.fulfillment_status),
      variantGid,
      productGid: numericGid("Product", lineItem.product_id),
      sku,
      quantity: lineItem.quantity ?? 0,
      title: lineItem.title ?? lineItem.name ?? "",
      variantTitle: lineItem.variant_title ?? null,
    });
  }
}

async function upsertClassBooking(input: {
  shop: string;
  classSessionId: string;
  orderGid: string;
  orderName: string;
  lineItemGid: string;
  orderCreatedAt: Date;
  email: string | null;
  customerGid: string | null;
  customerName: string | null;
  customerOrdersCount: number | null;
  customerLocation: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  variantGid: string | null;
  productGid: string | null;
  sku: string | null;
  quantity: number;
  title: string;
  variantTitle: string | null;
}) {
  await db.classBooking.upsert({
    where: {
      shop_lineItemGid: {
        shop: input.shop,
        lineItemGid: input.lineItemGid,
      },
    },
    create: input,
    update: input,
  });
}

function numericGid(
  type: "Customer" | "LineItem" | "Order" | "Product" | "ProductVariant",
  value: number | null | undefined,
): string | null {
  return value ? `gid://shopify/${type}/${value}` : null;
}

function normalizeStatus(value: string | null | undefined): string | null {
  return value ? value.toUpperCase().replace(/-/g, "_") : null;
}

function normalizeFulfillmentStatus(value: string | null | undefined): string {
  if (!value) return "UNFULFILLED";
  if (value === "partial") return "PARTIALLY_FULFILLED";
  return normalizeStatus(value) ?? "UNFULFILLED";
}

function customerLocation(
  address: NonNullable<ShopifyOrderWebhookPayload["customer"]>["default_address"],
): string | null {
  const cityProvince = [address?.city, address?.province_code]
    .filter(Boolean)
    .join(" ");
  return [cityProvince, address?.country].filter(Boolean).join(", ") || null;
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null && value !== "";
}
