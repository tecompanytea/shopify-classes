import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
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

type DashboardDay = {
  date: string;
  label: string;
  total: number;
  cancelled: number;
};

type DashboardLoader = {
  range: {
    start: string;
    end: string;
    label: string;
  };
  stats: {
    total: number;
    completed: number;
    cancelled: number;
    rescheduled: number;
  };
  days: DashboardDay[];
};

type SummaryIcon = "calendar" | "calendar-check" | "calendar-compare" | "calendar-time";

export const loader = async ({ request }: LoaderFunctionArgs): Promise<DashboardLoader> => {
  const { session, admin } = await authenticate.admin(request);
  const settings = await getOrCreateShopSettings(session.shop);
  const url = new URL(request.url);
  const timezone = settings.defaultTimezone;

  const today = DateTime.now().setZone(timezone).startOf("day");
  let end = parseDate(url.searchParams.get("end"), timezone) ?? today;
  let start = parseDate(url.searchParams.get("start"), timezone) ?? end.minus({ days: 7 });

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
  const days = makeDays(start, end);
  const dayBuckets = new Map(days.map((day) => [day.date, day]));
  const now = new Date();

  let total = 0;
  let completed = 0;
  let cancelled = 0;

  for (const booking of rangedBookings) {
    const quantity = booking.quantity;
    const linkedSession = sessionsByVariant.get(booking.variantId);
    const bookingCancelled = isCancelledBooking(booking, linkedSession);
    const createdDate = DateTime.fromISO(booking.createdAt, { zone: timezone }).toISODate();
    const day = createdDate ? dayBuckets.get(createdDate) : undefined;

    total += quantity;
    if (linkedSession && !linkedSession.cancelled && linkedSession.endsAt < now) {
      completed += quantity;
    }
    if (bookingCancelled) {
      cancelled += quantity;
    }
    if (day) {
      day.total += quantity;
      if (bookingCancelled) {
        day.cancelled += quantity;
      }
    }
  }

  return {
    range: {
      start: start.toISODate()!,
      end: end.toISODate()!,
      label: `${start.toFormat("LLL d, yyyy")} - ${end.toFormat("LLL d, yyyy")}`,
    },
    stats: {
      total,
      completed,
      cancelled,
      rescheduled: 0,
    },
    days,
  };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Dashboard() {
  const { range, stats, days } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Summary">
      <s-section>
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base">
            <s-icon type="calendar" />
            <s-heading>{range.label}</s-heading>
          </s-stack>

          <Form method="get">
            <s-stack direction="block" gap="base">
              <s-grid
                gridTemplateColumns="repeat(2, minmax(0, 1fr))"
                gap="base"
              >
                <s-date-field label="Start" name="start" defaultValue={range.start} />
                <s-date-field label="End" name="end" defaultValue={range.end} />
              </s-grid>
              <s-button type="submit">Apply date range</s-button>
            </s-stack>
          </Form>
        </s-stack>
      </s-section>

      <s-grid gridTemplateColumns="repeat(4, minmax(0, 1fr))" gap="base">
        <StatSection title="Total Bookings" value={stats.total} icon="calendar" />
        <StatSection title="Completed Bookings" value={stats.completed} icon="calendar-check" />
        <StatSection title="Cancelled Bookings" value={stats.cancelled} icon="calendar-compare" />
        <StatSection title="Rescheduled Bookings" value={stats.rescheduled} icon="calendar-time" />
      </s-grid>

      <s-section heading="Booking Analytics" padding="none">
        <s-table>
          <s-table-header-row>
            <s-table-header listSlot="primary">Date</s-table-header>
            <s-table-header format="numeric">Total bookings</s-table-header>
            <s-table-header format="numeric">Cancelled bookings</s-table-header>
          </s-table-header-row>
          <s-table-body>
            {days.map((day) => (
              <s-table-row key={day.date}>
                <s-table-cell>{day.label}</s-table-cell>
                <s-table-cell>{day.total}</s-table-cell>
                <s-table-cell>{day.cancelled}</s-table-cell>
              </s-table-row>
            ))}
          </s-table-body>
        </s-table>
      </s-section>
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

function makeDays(start: DateTime, end: DateTime): DashboardDay[] {
  const days: DashboardDay[] = [];
  for (let cursor = start; cursor <= end; cursor = cursor.plus({ days: 1 })) {
    days.push({
      date: cursor.toISODate()!,
      label: cursor.toFormat("LLL d"),
      total: 0,
      cancelled: 0,
    });
  }
  return days;
}

function parseDate(value: string | null, timezone: string): DateTime | null {
  if (!value) return null;
  const parsed = DateTime.fromISO(value, { zone: timezone }).startOf("day");
  return parsed.isValid ? parsed : null;
}

function isCancelledBooking(booking: BookingRow, session: SessionSummary | undefined) {
  const financialStatus = booking.financialStatus?.toLowerCase() ?? "";
  return (
    Boolean(session?.cancelled) ||
    financialStatus.includes("refunded") ||
    financialStatus.includes("voided")
  );
}
