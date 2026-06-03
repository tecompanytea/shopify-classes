import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type BookingRow = {
  orderId: string;
  orderName: string;
  lineItemId: string;
  createdAt: string;
  email: string | null;
  customerId: string | null;
  customerName: string | null;
  customerOrdersCount: number | null;
  customerLocation: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  variantId: string;
  productId: string | null;
  quantity: number;
  title: string;
  variantTitle: string | null;
};

type OrdersByProductResponse = {
  errors?: { message?: string }[];
  data?: {
    orders?: {
      pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
      nodes?: OrderNode[];
    };
  };
};

type OrderNode = {
  id: string;
  name: string;
  createdAt: string;
  email?: string | null;
  displayFinancialStatus?: string | null;
  displayFulfillmentStatus?: string | null;
  customer?: {
    id?: string | null;
    displayName?: string | null;
    numberOfOrders?: number | string | null;
    defaultAddress?: {
      city?: string | null;
      provinceCode?: string | null;
      country?: string | null;
    } | null;
  } | null;
  lineItems?: {
    nodes?: {
      id: string;
      quantity: number;
      title: string;
      variantTitle?: string | null;
      variant?: {
        id: string;
        product?: { id?: string | null } | null;
      } | null;
    }[];
  };
};

const ORDER_PAGE_SIZE = 250;
const PRODUCT_ID_BATCH_SIZE = 50;

// Pulls orders containing products that back class sessions, then filters the
// line items client-side to the exact variant GIDs. Searching by product ID
// keeps this narrow while still catching historical orders whose captured line
// item SKU was empty or later changed.
export async function listBookingsForVariants(
  admin: AdminApiContext,
  {
    variantGids,
    productGids,
    first = ORDER_PAGE_SIZE,
  }: { variantGids: string[]; productGids: string[]; first?: number },
): Promise<BookingRow[]> {
  if (variantGids.length === 0) return [];
  const variantSet = new Set(variantGids);
  const productIds = uniqueNumericIds(productGids);
  if (productIds.length === 0) return [];

  const rows: BookingRow[] = [];
  const seenLineItems = new Set<string>();

  for (const batch of chunk(productIds, PRODUCT_ID_BATCH_SIZE)) {
    const query = batch.map((id) => `product_id:${id}`).join(" OR ");
    let after: string | null = null;
    let hasNextPage = true;

    while (hasNextPage) {
      const response: Response = await admin.graphql(
        `#graphql
          query OrdersByProduct($first: Int!, $after: String, $query: String!) {
            orders(
              first: $first
              after: $after
              reverse: true
              sortKey: CREATED_AT
              query: $query
            ) {
              pageInfo {
                hasNextPage
                endCursor
              }
              nodes {
                id
                name
                createdAt
                email
                displayFinancialStatus
                displayFulfillmentStatus
                customer {
                  id
                  displayName
                  numberOfOrders
                  defaultAddress { city provinceCode country }
                }
                lineItems(first: 250) {
                  nodes {
                    id
                    quantity
                    title
                    variantTitle
                    variant {
                      id
                      product { id }
                    }
                  }
                }
              }
            }
          }
        `,
        { variables: { first, after, query } },
      );

      const body: OrdersByProductResponse = await response.json();
      if (body?.errors?.length) {
        throw new Error(
          `Failed to fetch class bookings: ${body.errors
            .map((error) => error.message)
            .filter(Boolean)
            .join("; ")}`,
        );
      }

      const orders: OrderNode[] = body?.data?.orders?.nodes ?? [];
      for (const order of orders) {
        const customer = order.customer ?? null;
        const addr = customer?.defaultAddress;
        const cityProvince = [addr?.city, addr?.provinceCode]
          .filter(Boolean)
          .join(" ");
        const customerLocation =
          [cityProvince, addr?.country].filter(Boolean).join(", ") || null;
        const customerOrdersCount =
          customer?.numberOfOrders != null ? Number(customer.numberOfOrders) : null;
        for (const li of order.lineItems?.nodes ?? []) {
          if (!li.variant) continue;
          if (!variantSet.has(li.variant.id)) continue;
          const rowKey = `${order.id}:${li.id}`;
          if (seenLineItems.has(rowKey)) continue;
          seenLineItems.add(rowKey);
          rows.push({
            orderId: order.id,
            orderName: order.name,
            lineItemId: li.id,
            createdAt: order.createdAt,
            email: order.email ?? null,
            customerId: customer?.id ?? null,
            customerName: customer?.displayName ?? null,
            customerOrdersCount,
            customerLocation,
            financialStatus: order.displayFinancialStatus ?? null,
            fulfillmentStatus: order.displayFulfillmentStatus ?? null,
            variantId: li.variant.id,
            productId: li.variant.product?.id ?? null,
            quantity: li.quantity,
            title: li.title,
            variantTitle: li.variantTitle ?? null,
          });
        }
      }

      const pageInfo = body?.data?.orders?.pageInfo;
      hasNextPage = Boolean(pageInfo?.hasNextPage);
      after = pageInfo?.endCursor ?? null;
      if (hasNextPage && !after) {
        throw new Error("Shopify returned an order page without a next cursor.");
      }
    }
  }

  return rows;
}

function uniqueNumericIds(gids: string[]): string[] {
  return Array.from(
    new Set(
      gids
        .map((gid) => gid.split("/").pop()?.trim() ?? "")
        .filter((id) => /^\d+$/.test(id)),
    ),
  );
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}
