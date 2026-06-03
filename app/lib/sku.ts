import { DateTime } from "luxon";

export const CLASS_SESSION_SKU_START = 620001;
export const CLASS_SESSION_SKU_END = 629999;

export function formatClassSessionSku(value: number): string {
  if (
    !Number.isInteger(value) ||
    value < CLASS_SESSION_SKU_START ||
    value > CLASS_SESSION_SKU_END
  ) {
    throw new Error("Class SKU sequence is exhausted.");
  }
  return String(value);
}

export function parseClassSessionSkuNumber(
  sku: string | null | undefined,
): number | null {
  const value = String(sku ?? "").trim();
  if (!/^62\d{4}$/.test(value)) return null;

  const number = Number(value);
  return number >= CLASS_SESSION_SKU_START && number <= CLASS_SESSION_SKU_END
    ? number
    : null;
}

export function isClassSessionSku(sku: string | null | undefined): boolean {
  return parseClassSessionSkuNumber(sku) !== null;
}

export function parseSessionSku(
  sku: string | null | undefined,
  timezone: string,
): { date: string; time: string; startsAtIso: string } | null {
  const match = sku?.match(/-(\d{8})-(\d{4})$/);
  if (!match) return null;

  const startsAt = DateTime.fromFormat(
    `${match[1]}${match[2]}`,
    "yyyyLLddHHmm",
    {
      zone: timezone,
    },
  );
  if (!startsAt.isValid) return null;

  return {
    date: startsAt.toFormat("yyyy-LL-dd"),
    time: startsAt.toFormat("HH:mm"),
    startsAtIso: startsAt.toISO()!,
  };
}

export function formatSessionTitle(
  startsAtIso: string,
  timezone: string,
): string {
  return DateTime.fromISO(startsAtIso, { zone: timezone }).toFormat(
    "ccc LLL d, yyyy 'at' h:mm a",
  );
}

// Compact, year-less class date for the bookings table.
// Example: "Saturday Jun 6, at 3:00 PM".
export function formatBookingDate(
  startsAtIso: string,
  timezone: string,
): string {
  return DateTime.fromISO(startsAtIso, { zone: timezone }).toFormat(
    "cccc LLL d, 'at' h:mm a",
  );
}
