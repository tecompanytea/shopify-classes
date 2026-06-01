import type { LoaderFunctionArgs } from "react-router";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import { getProduct } from "../.server/shopify/products";
import { CLASS_TIMEZONE } from "../lib/class-config";
import { parseSessionTitle } from "../lib/parse-session-title";

// Resource route (no UI). Given a productGid, return the product's existing
// variants that look like class dates, so the New-event wizard can adopt them
// as sessions instead of forcing the merchant to re-enter every date.
export type AdoptCandidate = {
  variantGid: string;
  inventoryItemGid: string | null;
  sku: string | null;
  title: string;
  date: string | null; // YYYY-MM-DD parsed from the title
  inventoryQuantity: number | null;
};

export type ProductVariantsResult = {
  candidates: AdoptCandidate[];
};

export const loader = async ({
  request,
}: LoaderFunctionArgs): Promise<ProductVariantsResult> => {
  const { admin } = await authenticate.admin(request);
  const productGid = new URL(request.url).searchParams.get("productGid");
  if (!productGid) return { candidates: [] };

  const product = await getProduct(admin, productGid);
  if (!product) return { candidates: [] };

  const now = DateTime.now().setZone(CLASS_TIMEZONE);

  // Only variants whose title parses to a date are session candidates. This
  // naturally skips the implicit "Default Title" variant and any pricing-tier
  // options (e.g. Adult / Child) that aren't dates.
  const candidates: AdoptCandidate[] = product.variants
    .map((v) => ({
      variantGid: v.id,
      inventoryItemGid: v.inventoryItemId,
      sku: v.sku,
      title: v.title,
      date: parseSessionTitle(v.title, now).date,
      inventoryQuantity: v.inventoryQuantity,
    }))
    .filter((c) => c.date != null);

  return { candidates };
};
