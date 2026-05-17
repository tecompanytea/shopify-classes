import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { DateTime } from "luxon";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listBookingsForVariants, type BookingRow } from "../.server/shopify/orders";
import { getOrCreateShopSettings } from "../lib/settings.server";
import styles from "../styles/dashboard.module.css";

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
      <div className={styles.dashboard}>
        <Form method="get" className={styles.rangeForm}>
          <details className={styles.rangeDetails}>
            <summary className={styles.rangePill}>
              <CalendarIcon />
              <span>{range.label}</span>
            </summary>
            <div className={styles.rangePanel}>
              <label>
                <span>Start</span>
                <input type="date" name="start" defaultValue={range.start} />
              </label>
              <label>
                <span>End</span>
                <input type="date" name="end" defaultValue={range.end} />
              </label>
              <button type="submit">Apply</button>
            </div>
          </details>
        </Form>

        <section className={styles.statGrid} aria-label="Booking summary">
          <StatCard title="Total Bookings" value={stats.total} icon={<CalendarIcon />} />
          <StatCard title="Completed Bookings" value={stats.completed} icon={<CompletedIcon />} />
          <StatCard title="Cancelled Bookings" value={stats.cancelled} icon={<CancelledIcon />} />
          <StatCard title="Rescheduled Bookings" value={stats.rescheduled} icon={<RescheduledIcon />} />
        </section>

        <section className={styles.chartCard} aria-labelledby="booking-analytics-title">
          <h2 id="booking-analytics-title">Booking Analytics</h2>
          <BookingChart days={days} />
        </section>
      </div>
    </s-page>
  );
}

function StatCard({
  title,
  value,
  icon,
}: {
  title: string;
  value: number;
  icon: React.ReactNode;
}) {
  return (
    <article className={styles.statCard}>
      <div className={styles.statTitleRow}>
        <h2>{title}</h2>
        <span className={styles.statIcon} aria-hidden="true">
          {icon}
        </span>
      </div>
      <p>{value.toLocaleString()}</p>
    </article>
  );
}

function BookingChart({ days }: { days: DashboardDay[] }) {
  const width = 960;
  const height = 420;
  const chart = {
    left: 58,
    right: 26,
    top: 26,
    bottom: 72,
  };
  const chartWidth = width - chart.left - chart.right;
  const chartHeight = height - chart.top - chart.bottom;
  const rawMaxValue = Math.max(4, ...days.flatMap((day) => [day.total, day.cancelled]));
  const maxValue = Math.max(4, Math.ceil(rawMaxValue / 4) * 4);
  const ticks = Array.from({ length: 5 }, (_, index) => maxValue - index * (maxValue / 4));
  const pointFor = (day: DashboardDay, index: number, key: "total" | "cancelled") => {
    const divisor = Math.max(days.length - 1, 1);
    const x = chart.left + (chartWidth * index) / divisor;
    const y = chart.top + chartHeight - (chartHeight * day[key]) / maxValue;
    return { x, y };
  };
  const totalPoints = days.map((day, index) => pointFor(day, index, "total"));
  const cancelledPoints = days.map((day, index) => pointFor(day, index, "cancelled"));

  return (
    <div className={styles.chartWrap}>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Total and cancelled bookings over the selected date range">
        {ticks.map((tick) => {
          const y = chart.top + chartHeight - (chartHeight * tick) / maxValue;
          return (
            <g key={tick}>
              <line
                x1={chart.left}
                x2={width - chart.right}
                y1={y}
                y2={y}
                className={styles.gridLine}
              />
              <text x={chart.left - 12} y={y + 5} textAnchor="end" className={styles.axisText}>
                {Number.isInteger(tick) ? tick : tick.toFixed(1)}
              </text>
            </g>
          );
        })}

        {days.map((day, index) => {
          const { x } = pointFor(day, index, "total");
          return (
            <g key={day.date}>
              <line
                x1={x}
                x2={x}
                y1={chart.top}
                y2={chart.top + chartHeight}
                className={styles.gridLine}
              />
              <text x={x} y={height - 42} textAnchor="middle" className={styles.axisText}>
                {day.label}
              </text>
            </g>
          );
        })}

        <line
          x1={chart.left}
          x2={chart.left}
          y1={chart.top}
          y2={chart.top + chartHeight}
          className={styles.axisLine}
        />
        <line
          x1={chart.left}
          x2={width - chart.right}
          y1={chart.top + chartHeight}
          y2={chart.top + chartHeight}
          className={styles.axisLine}
        />

        <polyline
          points={totalPoints.map(({ x, y }) => `${x},${y}`).join(" ")}
          className={styles.totalLine}
        />
        <polyline
          points={cancelledPoints.map(({ x, y }) => `${x},${y}`).join(" ")}
          className={styles.cancelledLine}
        />
        {totalPoints.map((point, index) => (
          <circle key={`total-${days[index].date}`} cx={point.x} cy={point.y} r="4" className={styles.totalDot} />
        ))}
        {cancelledPoints.map((point, index) => (
          <circle
            key={`cancelled-${days[index].date}`}
            cx={point.x}
            cy={point.y}
            r="4"
            className={styles.cancelledDot}
          />
        ))}
      </svg>
      <div className={styles.legend}>
        <span className={styles.totalLegend}>Total Bookings</span>
        <span className={styles.cancelledLegend}>Cancelled Bookings</span>
      </div>
    </div>
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

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M7 3v3M17 3v3M4.5 9.5h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v10A2.5 2.5 0 0 1 17.5 20h-11A2.5 2.5 0 0 1 4 17.5v-10A2.5 2.5 0 0 1 6.5 5Z" />
    </svg>
  );
}

function CompletedIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M7 3v3M17 3v3M4.5 9.5h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v5.5M4 17.5v-10A2.5 2.5 0 0 1 6.5 5M7 20h5M15 18l2 2 4-5" />
    </svg>
  );
}

function CancelledIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M7 3v3M17 3v3M4.5 9.5h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v5.5M4 17.5v-10A2.5 2.5 0 0 1 6.5 5M15 16l5 5M20 16l-5 5" />
    </svg>
  );
}

function RescheduledIcon() {
  return (
    <svg viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d="M7 3v3M17 3v3M4.5 9.5h15M6.5 5h11A2.5 2.5 0 0 1 20 7.5v4M4 17.5v-10A2.5 2.5 0 0 1 6.5 5M17.5 14a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM17.5 16.2v2.1l1.6 1" />
    </svg>
  );
}
