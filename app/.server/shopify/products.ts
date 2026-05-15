import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";

export type ShopifyProductSummary = {
  id: string;
  title: string;
  handle: string;
  status: string;
  featuredImage: string | null;
  variantsCount: number;
};

export type ShopifyProductDetail = ShopifyProductSummary & {
  descriptionHtml: string;
  variants: Array<{
    id: string;
    title: string;
    sku: string | null;
    price: string;
    inventoryQuantity: number | null;
    inventoryItemId: string | null;
  }>;
};

const PRODUCT_SUMMARY_FIELDS = /* GraphQL */ `
  id
  title
  handle
  status
  featuredImage { url }
  variantsCount { count }
`;

export async function searchProducts(
  admin: AdminApiContext,
  { query, first = 20 }: { query?: string; first?: number } = {},
): Promise<ShopifyProductSummary[]> {
  const response = await admin.graphql(
    `#graphql
      query SearchProducts($query: String, $first: Int!) {
        products(first: $first, query: $query) {
          nodes { ${PRODUCT_SUMMARY_FIELDS} }
        }
      }
    `,
    { variables: { query: query ?? undefined, first } },
  );

  const body = await response.json();
  const nodes = body?.data?.products?.nodes ?? [];
  return nodes.map(mapProductSummary);
}

export async function getProduct(
  admin: AdminApiContext,
  productGid: string,
): Promise<ShopifyProductDetail | null> {
  const response = await admin.graphql(
    `#graphql
      query GetProduct($id: ID!) {
        product(id: $id) {
          ${PRODUCT_SUMMARY_FIELDS}
          descriptionHtml
          variants(first: 250) {
            nodes {
              id
              title
              sku
              price
              inventoryQuantity
              inventoryItem { id }
            }
          }
        }
      }
    `,
    { variables: { id: productGid } },
  );

  const body = await response.json();
  const product = body?.data?.product;
  if (!product) return null;

  return {
    ...mapProductSummary(product),
    descriptionHtml: product.descriptionHtml ?? "",
    variants: (product.variants?.nodes ?? []).map((v: {
      id: string;
      title: string;
      sku: string | null;
      price: string;
      inventoryQuantity: number | null;
      inventoryItem: { id: string } | null;
    }) => ({
      id: v.id,
      title: v.title,
      sku: v.sku,
      price: v.price,
      inventoryQuantity: v.inventoryQuantity,
      inventoryItemId: v.inventoryItem?.id ?? null,
    })),
  };
}

export async function ensureSessionDateOption(
  admin: AdminApiContext,
  productGid: string,
): Promise<{ optionId: string; name: string } | null> {
  // Make sure the product has an option named "Session" we can attach
  // variant-session values to. If it already has one, reuse it; otherwise
  // create it.
  const response = await admin.graphql(
    `#graphql
      query ProductOptions($id: ID!) {
        product(id: $id) {
          options { id name }
        }
      }
    `,
    { variables: { id: productGid } },
  );

  const body = await response.json();
  const existing = (body?.data?.product?.options ?? []).find(
    (o: { name: string }) => o.name.toLowerCase() === "session",
  );
  if (existing) return { optionId: existing.id, name: existing.name };

  const create = await admin.graphql(
    `#graphql
      mutation CreateSessionOption($productId: ID!, $options: [OptionCreateInput!]!) {
        productOptionsCreate(productId: $productId, options: $options) {
          product { options { id name } }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId: productGid,
        options: [{ name: "Session", values: [{ name: "TBD" }] }],
      },
    },
  );
  const createBody = await create.json();
  const errors = createBody?.data?.productOptionsCreate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(`productOptionsCreate: ${errors.map((e: { message: string }) => e.message).join("; ")}`);
  }
  const newOption = (createBody?.data?.productOptionsCreate?.product?.options ?? []).find(
    (o: { name: string }) => o.name.toLowerCase() === "session",
  );
  return newOption ? { optionId: newOption.id, name: newOption.name } : null;
}

function mapProductSummary(p: {
  id: string;
  title: string;
  handle: string;
  status: string;
  featuredImage?: { url: string } | null;
  variantsCount?: { count: number } | null;
}): ShopifyProductSummary {
  return {
    id: p.id,
    title: p.title,
    handle: p.handle,
    status: p.status,
    featuredImage: p.featuredImage?.url ?? null,
    variantsCount: p.variantsCount?.count ?? 0,
  };
}
