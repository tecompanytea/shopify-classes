import db from "../db.server";

// Returns the per-shop defaults, creating the row on first access.
export async function getOrCreateShopSettings(shop: string) {
  const existing = await db.shopSettings.findUnique({
    where: { shop },
    include: { defaultLocation: true },
  });
  if (existing) return existing;
  return db.shopSettings.create({
    data: { shop },
    include: { defaultLocation: true },
  });
}
