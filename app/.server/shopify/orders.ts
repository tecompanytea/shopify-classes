import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type BookingRow = {
  orderId: string;
  orderName: string;
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

// Pulls recent orders containing line items whose variant matches one of the
// supplied class variant GIDs. For v1 we filter client-side after fetching a
// reasonable window — the Admin API doesn't support `line_items.variant_id`
// in the search query.
export async function listBookingsForVariants(
  admin: AdminApiContext,
  { variantGids, first = 100 }: { variantGids: string[]; first?: number },
): Promise<BookingRow[]> {
  if (variantGids.length === 0) return [];
  const variantSet = new Set(variantGids);

  const response = await admin.graphql(
    `#graphql
      query RecentOrders($first: Int!) {
        orders(first: $first, reverse: true, sortKey: CREATED_AT) {
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
            lineItems(first: 50) {
              nodes {
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
    { variables: { first } },
  );

  const body = await response.json();
  const orders = body?.data?.orders?.nodes ?? [];
  const rows: BookingRow[] = [];

  for (const order of orders) {
    const customer = order.customer ?? null;
    const addr = customer?.defaultAddress;
    const cityProvince = [addr?.city, addr?.provinceCode].filter(Boolean).join(" ");
    const customerLocation =
      [cityProvince, addr?.country].filter(Boolean).join(", ") || null;
    const customerOrdersCount =
      customer?.numberOfOrders != null ? Number(customer.numberOfOrders) : null;
    for (const li of order.lineItems?.nodes ?? []) {
      if (!li.variant) continue;
      if (!variantSet.has(li.variant.id)) continue;
      rows.push({
        orderId: order.id,
        orderName: order.name,
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

  return rows;
}
