import { DateTime } from "luxon";

// Generates a deterministic SKU for a class session variant.
// Format: CLASS-{SLUG}-{YYYYMMDD}-{HHMM}
// Example: CLASS-BREWING-WORKSHOP-20260523-1500
export function generateSessionSku(productTitle: string, startsAtIso: string, timezone: string): string {
  const dt = DateTime.fromISO(startsAtIso, { zone: timezone });
  const slug = productTitle
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const date = dt.toFormat("yyyyLLdd");
  const time = dt.toFormat("HHmm");
  return `CLASS-${slug}-${date}-${time}`;
}

export function formatSessionTitle(startsAtIso: string, timezone: string): string {
  return DateTime.fromISO(startsAtIso, { zone: timezone }).toFormat(
    "ccc LLL d, yyyy 'at' h:mm a",
  );
}

// Compact, year-less class date for the bookings table.
// Example: "Saturday Jun 6, at 3:00 PM".
export function formatBookingDate(startsAtIso: string, timezone: string): string {
  return DateTime.fromISO(startsAtIso, { zone: timezone }).toFormat(
    "cccc LLL d, 'at' h:mm a",
  );
}
