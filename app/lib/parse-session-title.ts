import { DateTime } from "luxon";

// Best-effort parser for an existing product variant title that represents a
// class date (e.g. "Saturday 5/23", "Sat 6/6", "July 4", "6/20/2026").
//
// The year is usually absent — these classes run year-round — so we infer it:
// when the title names a weekday we pick the nearby year where the month/day
// actually lands on that weekday; otherwise we pick the nearby year closest to
// now. Either way the result is a starting point the merchant confirms.

export type ParsedSessionTitle = {
  /** YYYY-MM-DD in the given zone, or null if no date could be parsed. */
  date: string | null;
};

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

// Luxon weekday numbers: Monday = 1 … Sunday = 7.
const WEEKDAYS: Record<string, number> = {
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 7,
};

function normalizeYear(year: number): number {
  return year < 100 ? 2000 + year : year;
}

function findWeekday(lower: string): number | null {
  const match = lower.match(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/);
  return match ? WEEKDAYS[match[1]] ?? null : null;
}

function inferYear(
  month: number,
  day: number,
  weekday: number | null,
  now: DateTime,
): number {
  const zone = now.zoneName ?? "utc";
  const candidates = [now.year - 1, now.year, now.year + 1, now.year + 2]
    .map((year) => DateTime.fromObject({ year, month, day }, { zone }))
    .filter((dt) => dt.isValid);
  if (candidates.length === 0) return now.year;

  let pool = candidates;
  if (weekday != null) {
    const matching = candidates.filter((dt) => dt.weekday === weekday);
    if (matching.length) pool = matching;
  }

  // Prefer the candidate whose date is closest to now.
  pool.sort(
    (a, b) => Math.abs(a.diff(now).as("days")) - Math.abs(b.diff(now).as("days")),
  );
  return pool[0].year;
}

export function parseSessionTitle(title: string, now: DateTime): ParsedSessionTitle {
  const lower = title.toLowerCase().trim();
  const weekday = findWeekday(lower);

  let month: number | null = null;
  let day: number | null = null;
  let explicitYear: number | null = null;

  const slash = lower.match(/\b(\d{1,2})\s*[/\-]\s*(\d{1,2})(?:\s*[/\-]\s*(\d{2,4}))?\b/);
  if (slash) {
    month = Number(slash[1]);
    day = Number(slash[2]);
    if (slash[3]) explicitYear = normalizeYear(Number(slash[3]));
  } else {
    const named = lower.match(
      /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:,?\s*(\d{4}))?/,
    );
    if (named) {
      month = MONTHS[named[1]] ?? null;
      day = Number(named[2]);
      if (named[3]) explicitYear = Number(named[3]);
    } else {
      const dayFirst = lower.match(
        /\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*/,
      );
      if (dayFirst) {
        day = Number(dayFirst[1]);
        month = MONTHS[dayFirst[2]] ?? null;
      }
    }
  }

  if (!month || !day || month < 1 || month > 12 || day < 1 || day > 31) {
    return { date: null };
  }

  const year = explicitYear ?? inferYear(month, day, weekday, now);
  const zone = now.zoneName ?? "utc";
  const dt = DateTime.fromObject({ year, month, day }, { zone });
  if (!dt.isValid) return { date: null };

  return { date: dt.toFormat("yyyy-LL-dd") };
}
