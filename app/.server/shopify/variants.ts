import type { AdminApiContext } from "@shopify/shopify-app-react-router/server";
import type { SessionDateOption } from "./products";

export type SessionDraft = {
  startsAt: Date;
  timezone: string;
  capacity: number;
  sku: string;
  displayName: string; // human-readable variant title, e.g. "Sat May 23 at 3:00 PM"
};

export type SessionCreateResult = {
  variantGid: string;
  inventoryItemGid: string | null;
  sku: string;
  displayName: string;
};

// Bulk-creates one variant per session draft. Each variant uses the product's
// resolved date/session option, with the human-readable date string as its
// value. Shopify enforces unique option-value tuples per product, which is
// exactly what we want — a duplicate date fails loudly instead of colliding.
export async function createSessionVariants(
  admin: AdminApiContext,
  {
    productGid,
    drafts,
    currencyCode,
    option,
  }: {
    productGid: string;
    drafts: SessionDraft[];
    currencyCode: string;
    option: SessionDateOption;
  },
): Promise<SessionCreateResult[]> {
  if (drafts.length === 0) return [];

  const variants = drafts.map((draft) => ({
    optionValues: buildSessionOptionValues(option, draft.displayName),
    inventoryItem: {
      sku: draft.sku,
      tracked: true,
    },
    inventoryQuantities: undefined as
      | undefined
      | { availableQuantity: number; locationId: string }[],
  }));

  const response = await admin.graphql(
    `#graphql
      mutation CreateSessionVariants($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkCreate(productId: $productId, variants: $variants, strategy: REMOVE_STANDALONE_VARIANT) {
          productVariants {
            id
            sku
            title
            inventoryItem { id }
          }
          userErrors { field message }
        }
      }
    `,
    { variables: { productId: productGid, variants } },
  );

  const body = await response.json();
  const payload = body?.data?.productVariantsBulkCreate;
  const errors = payload?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `productVariantsBulkCreate: ${errors
        .map(
          (e: { field?: string[]; message: string }) =>
            `${e.field?.join(".") ?? ""} ${e.message}`,
        )
        .join("; ")}`,
    );
  }

  // Suppress unused-locals warnings — currencyCode is reserved for future
  // currency-aware variant creation if Shopify requires an explicit price.
  void currencyCode;

  return (payload?.productVariants ?? []).map(
    (v: {
      id: string;
      sku: string | null;
      title: string;
      inventoryItem: { id: string } | null;
    }) => ({
      variantGid: v.id,
      inventoryItemGid: v.inventoryItem?.id ?? null,
      sku: v.sku ?? "",
      displayName: v.title,
    }),
  );
}

// Updates an existing session variant's date option value (the human-readable
// title customers see) and its SKU. Used when a merchant edits a session's
// date/time after creation. Shopify still enforces unique option-value tuples,
// so editing to a date that already exists on the product fails loudly.
export async function updateSessionVariant(
  admin: AdminApiContext,
  {
    productGid,
    variantId,
    displayName,
    sku,
    option,
  }: {
    productGid: string;
    variantId: string;
    displayName: string;
    sku: string;
    option: SessionDateOption;
  },
): Promise<void> {
  const response = await admin.graphql(
    `#graphql
      mutation UpdateSessionVariant($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku title }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId: productGid,
        variants: [
          {
            id: variantId,
            optionValues: [
              { optionId: option.sessionOption.id, name: displayName },
            ],
            inventoryItem: { sku },
          },
        ],
      },
    },
  );

  const body = await response.json();
  const errors = body?.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `productVariantsBulkUpdate: ${errors
        .map(
          (e: { field?: string[]; message: string }) =>
            `${e.field?.join(".") ?? ""} ${e.message}`,
        )
        .join("; ")}`,
    );
  }
}

export async function updateVariantSkus(
  admin: AdminApiContext,
  {
    productGid,
    variants,
  }: {
    productGid: string;
    variants: Array<{ variantId: string; sku: string }>;
  },
): Promise<void> {
  if (variants.length === 0) return;

  const response = await admin.graphql(
    `#graphql
      mutation UpdateVariantSkus($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
        productVariantsBulkUpdate(productId: $productId, variants: $variants) {
          productVariants { id sku }
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        productId: productGid,
        variants: variants.map((variant) => ({
          id: variant.variantId,
          inventoryItem: { sku: variant.sku },
        })),
      },
    },
  );

  const body = await response.json();
  const errors = body?.data?.productVariantsBulkUpdate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `productVariantsBulkUpdate: ${errors
        .map(
          (e: { field?: string[]; message: string }) =>
            `${e.field?.join(".") ?? ""} ${e.message}`,
        )
        .join("; ")}`,
    );
  }
}

function buildSessionOptionValues(
  option: SessionDateOption,
  displayName: string,
): Array<{ optionId: string; name: string }> {
  return option.productOptions.map((productOption) => ({
    optionId: productOption.id,
    name:
      productOption.id === option.sessionOption.id
        ? displayName
        : (productOption.values[0] ?? "Default Title"),
  }));
}

export async function deleteVariants(
  admin: AdminApiContext,
  { productGid, variantIds }: { productGid: string; variantIds: string[] },
): Promise<void> {
  if (variantIds.length === 0) return;
  const response = await admin.graphql(
    `#graphql
      mutation DeleteVariants($productId: ID!, $variantsIds: [ID!]!) {
        productVariantsBulkDelete(productId: $productId, variantsIds: $variantsIds) {
          userErrors { field message }
        }
      }
    `,
    { variables: { productId: productGid, variantsIds: variantIds } },
  );
  const body = await response.json();
  const errors = body?.data?.productVariantsBulkDelete?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `productVariantsBulkDelete: ${errors.map((e: { message: string }) => e.message).join("; ")}`,
    );
  }
}

// Activate the inventory item at the chosen Shopify location and set the
// quantity to the requested capacity. Called once per new variant after
// productVariantsBulkCreate.
export async function setInventoryAtLocation(
  admin: AdminApiContext,
  {
    inventoryItemGid,
    locationGid,
    quantity,
  }: { inventoryItemGid: string; locationGid: string; quantity: number },
): Promise<void> {
  const activate = await admin.graphql(
    `#graphql
      mutation Activate($inventoryItemId: ID!, $locationId: ID!, $available: Int) {
        inventoryActivate(inventoryItemId: $inventoryItemId, locationId: $locationId, available: $available) {
          userErrors { field message }
        }
      }
    `,
    {
      variables: {
        inventoryItemId: inventoryItemGid,
        locationId: locationGid,
        available: quantity,
      },
    },
  );
  const body = await activate.json();
  const errors = body?.data?.inventoryActivate?.userErrors ?? [];
  if (errors.length) {
    throw new Error(
      `inventoryActivate: ${errors.map((e: { message: string }) => e.message).join("; ")}`,
    );
  }
}
