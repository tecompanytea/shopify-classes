import db from "../db.server";
import {
  CLASS_TIMEZONE,
  DEFAULT_CLASS_CAPACITY,
  DEFAULT_CLASS_START_TIME,
} from "./class-config";

// Returns the per-shop defaults, creating the row on first access.
export async function getOrCreateShopSettings(shop: string) {
  const existing = await db.shopSettings.findUnique({
    where: { shop },
    include: { defaultLocation: true },
  });
  if (existing) return existing;
  return db.shopSettings.create({
    data: {
      shop,
      defaultTimezone: CLASS_TIMEZONE,
      defaultStartTime: DEFAULT_CLASS_START_TIME,
      defaultCapacity: DEFAULT_CLASS_CAPACITY,
    },
    include: { defaultLocation: true },
  });
}
