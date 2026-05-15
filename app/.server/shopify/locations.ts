import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type ShopifyLocation = {
  id: string;
  name: string;
  isActive: boolean;
  fulfillsOnlineOrders: boolean;
};

export async function listShopifyLocations(
  admin: AdminApiContext,
): Promise<ShopifyLocation[]> {
  const response = await admin.graphql(
    `#graphql
      query Locations {
        locations(first: 50, includeInactive: false) {
          nodes {
            id
            name
            isActive
            fulfillsOnlineOrders
          }
        }
      }
    `,
  );
  const body = await response.json();
  return body?.data?.locations?.nodes ?? [];
}

export async function getShopCurrency(
  admin: AdminApiContext,
): Promise<string> {
  const response = await admin.graphql(
    `#graphql
      query ShopCurrency { shop { currencyCode } }
    `,
  );
  const body = await response.json();
  return body?.data?.shop?.currencyCode ?? "USD";
}
