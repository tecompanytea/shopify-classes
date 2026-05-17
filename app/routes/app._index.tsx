import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listBookingsForVariants, type BookingRow } from "../.server/shopify/orders";
import { getOrCreateShopSettings } from "../lib/settings.server";

type SessionSummary = {
  variantGid: string;
  endsAt: Date;
  cancelled: boolean;
};

type DashboardLoader = {
  range: {
    start: string;
    end: string;
    label: string;
    preset: RangePreset;
  };
  stats: {
    total: number;
    completed: number;
    cancelled: number;
    rescheduled: number;
  };
};

type SummaryIcon = "calendar" | "calendar-check" | "calendar-compare" | "calendar-time";
type RangePreset =
  | "today"
  | "yesterday"
  | "last-7-days"
  | "last-14-days"
  | "next-7-days"
  | "next-14-days"
  | "next-30-days"
  | "custom";

const RANGE_OPTIONS: { label: string; preset: Exclude<RangePreset, "custom"> }[] = [
  { label: "Today", preset: "today" },
  { label: "Yesterday", preset: "yesterday" },
  { label: "Last 7 days", preset: "last-7-days" },
  { label: "Last 14 days", preset: "last-14-days" },
  { label: "Next 7 days", preset: "next-7-days" },
  { label: "Next 14 days", preset: "next-14-days" },
  { label: "Next 30 days", preset: "next-30-days" },
];

export const loader = async ({ request }: LoaderFunctionArgs): Promise<DashboardLoader> => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);
  const url = new URL(request.url);
  const timezone = settings.defaultTimezone;

  const today = DateTime.now().setZone(timezone).startOf("day");
  const requestedPreset = parseRangePreset(url.searchParams.get("range"));
  const customStart = url.searchParams.get("start");
  const customEnd = url.searchParams.get("end");
  const selectedRange =
    requestedPreset != null
      ? rangeForPreset(requestedPreset, today)
      : customStart != null || customEnd != null
        ? {
            start: parseDate(customStart, timezone) ?? today.minus({ days: 7 }),
            end: parseDate(customEnd, timezone) ?? today,
            preset: "custom" as const,
          }
      : {
          ...rangeForPreset("last-7-days", today),
        };
  let { start, end } = selectedRange;
  const { preset } = selectedRange;

  if (start > end) {
    [start, end] = [end, start];
  }
  if (end.diff(start, "days").days > 30) {
    start = end.minus({ days: 30 });
  }

  const sessions = await db.classSession.findMany({
    where: { shop: session.shop },
    select: {
      variantGid: true,
      endsAt: true,
      cancelled: true,
    },
  });

  const variantGids = Array.from(new Set(sessions.map((s) => s.variantGid)));
  const bookings =
    variantGids.length > 0
      ? await listBookingsForVariants(admin, { variantGids })
      : [];
  const sessionsByVariant = new Map<string, SessionSummary>(
    sessions.map((s) => [s.variantGid, s]),
  );

  const rangeEndExclusive = end.plus({ days: 1 });
  const rangedBookings = bookings.filter((booking) => {
    const createdAt = DateTime.fromISO(booking.createdAt, { zone: timezone });
    return createdAt >= start && createdAt < rangeEndExclusive;
  });
  const now = new Date();

  let total = 0;
  let completed = 0;
  let cancelled = 0;

  for (const booking of rangedBookings) {
    const quantity = booking.quantity;
    const linkedSession = sessionsByVariant.get(booking.variantId);
    const bookingCancelled = isCancelledBooking(booking, linkedSession);

    total += quantity;
    if (linkedSession && !linkedSession.cancelled && linkedSession.endsAt < now) {
      completed += quantity;
    }
    if (bookingCancelled) {
      cancelled += quantity;
    }
  }

  return {
    range: {
      start: start.toISODate()!,
      end: end.toISODate()!,
      label: `${start.toFormat("LLL d, yyyy")} - ${end.toFormat("LLL d, yyyy")}`,
      preset,
    },
    stats: {
      total,
      completed,
      cancelled,
      rescheduled: 0,
    },
  };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Dashboard() {
  const { range, stats } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Summary">
      <s-stack direction="block" gap="base">
        <s-box>
          <s-button
            icon="calendar"
            commandFor="summary-range-menu"
            command="--toggle"
          >
            {range.label}
          </s-button>
          <s-menu id="summary-range-menu" accessibilityLabel="Select date range">
            {RANGE_OPTIONS.map((option) => (
              <s-button
                key={option.preset}
                href={`/app?range=${option.preset}`}
                icon={range.preset === option.preset ? "check" : undefined}
              >
                {option.label}
              </s-button>
            ))}
          </s-menu>
        </s-box>

        <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
          <StatSection title="Total Bookings" value={stats.total} icon="calendar" />
          <StatSection title="Completed Bookings" value={stats.completed} icon="calendar-check" />
          <StatSection title="Cancelled Bookings" value={stats.cancelled} icon="calendar-compare" />
          <StatSection title="Rescheduled Bookings" value={stats.rescheduled} icon="calendar-time" />
        </s-grid>
      </s-stack>
    </s-page>
  );
}

function StatSection({
  title,
  value,
  icon,
}: {
  title: string;
  value: number;
  icon: SummaryIcon;
}) {
  return (
    <s-section>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base">
          <s-icon type={icon} />
          <s-heading>{title}</s-heading>
        </s-stack>
        <s-text>{value.toLocaleString()}</s-text>
      </s-stack>
    </s-section>
  );
}

function parseDate(value: string | null, timezone: string): DateTime | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  return parsed.isValid ? parsed : null;
}

function parseRangePreset(value: string | null): Exclude<RangePreset, "custom"> | null {
  const preset = RANGE_OPTIONS.find((option) => option.preset === value)?.preset;
  return preset ?? null;
}

function rangeForPreset(
  preset: Exclude<RangePreset, "custom">,
  today: DateTime,
): { start: DateTime; end: DateTime; preset: Exclude<RangePreset, "custom"> } {
  switch (preset) {
    case "today":
      return { start: today, end: today, preset };
    case "yesterday": {
      const yesterday = today.minus({ days: 1 });
      return { start: yesterday, end: yesterday, preset };
    }
    case "last-14-days":
      return { start: today.minus({ days: 14 }), end: today, preset };
    case "next-7-days":
      return { start: today, end: today.plus({ days: 7 }), preset };
    case "next-14-days":
      return { start: today, end: today.plus({ days: 14 }), preset };
    case "next-30-days":
      return { start: today, end: today.plus({ days: 30 }), preset };
    case "last-7-days":
    default:
      return { start: today.minus({ days: 7 }), end: today, preset };
  }
}

function isCancelledBooking(booking: BookingRow, session: SessionSummary | undefined) {
  const financialStatus = booking.financialStatus?.toLowerCase() ?? "";
  return (
    Boolean(session?.cancelled) ||
    financialStatus.includes("refunded") ||
    financialStatus.includes("voided")
  );
}
