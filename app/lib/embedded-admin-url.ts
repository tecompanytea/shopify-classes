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

export function shopFromAdminReferer(referer: string | null) {
  if (!referer) return null;

  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return null;
  }

  if (url.hostname !== "admin.shopify.com") return null;

  const storeHandle = url.pathname.match(/\/store\/([^/]+)/)?.[1];
  if (!storeHandle) return null;

  return `${decodeURIComponent(storeHandle)}.myshopify.com`;
}

export function configuredShop() {
  return (
    process.env.SHOPIFY_SHOP_DOMAIN ||
    process.env.SHOPIFY_STORE_DOMAIN ||
    process.env.SHOPIFY_SHOP ||
    null
  );
}

export function chooseInstalledShop(shops: string[]) {
  const uniqueShops = [...new Set(shops.filter(Boolean))];
  return (
    uniqueShops.find((shop) => !shop.toLowerCase().includes("dev")) ||
    uniqueShops[0] ||
    null
  );
}
