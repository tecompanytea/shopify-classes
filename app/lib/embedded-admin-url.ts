export function embeddedAppPath(
  path: string,
  shop: string,
  hostParam = shopifyAdminHostParam(shop),
) {
  const params = new URLSearchParams();
  params.set("shop", shop);
  params.set("host", hostParam);
  params.set("embedded", "1");
  return `${path}?${params.toString()}`;
}

export function shopifyAdminHostParam(shop: string) {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  return Buffer.from(`admin.shopify.com/store/${storeHandle}`).toString(
    "base64",
  );
}
