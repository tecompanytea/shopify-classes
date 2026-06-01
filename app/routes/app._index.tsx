import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useNavigate,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listBookingsForVariants, type BookingRow } from "../.server/shopify/orders";
import { CLASS_TIMEZONE } from "../lib/class-config";
import { formatSessionTitle } from "../lib/sku";

type Scope = "upcoming" | "past" | "all";

const SCOPE_OPTIONS: { label: string; scope: Scope }[] = [
  { label: "Upcoming", scope: "upcoming" },
  { label: "Past", scope: "past" },
  { label: "All", scope: "all" },
];

const DEFAULT_SCOPE: Scope = "upcoming";

type BookingTableRow = BookingRow & {
  classTitle: string;
  sessionStartsAt: string;
};

type LoaderResult = {
  scope: Scope;
  rows: BookingTableRow[];
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderResult> => {
  const { session, admin } = await authenticate.admin(request);
  const scope = parseScope(new URL(request.url).searchParams.get("scope")) ?? DEFAULT_SCOPE;

  const now = new Date();
  const startsAtFilter =
    scope === "upcoming" ? { gte: now } : scope === "past" ? { lt: now } : undefined;

  const sessions = await db.classSession.findMany({
    where: {
      shop: session.shop,
      cancelled: false,
      ...(startsAtFilter ? { startsAt: startsAtFilter } : {}),
    },
    include: { classProduct: { select: { title: true } } },
  });

  if (sessions.length === 0) return { scope, rows: [] };

  const variantToSession = new Map(sessions.map((s) => [s.variantGid, s]));
  const bookings = await listBookingsForVariants(admin, {
    variantGids: sessions.map((s) => s.variantGid),
  });

  const rows: BookingTableRow[] = [];
  for (const b of bookings) {
    const s = variantToSession.get(b.variantId);
    if (!s) continue;
    rows.push({
      ...b,
      classTitle: s.classProduct.title,
      sessionStartsAt: s.startsAt.toISOString(),
    });
  }

  // Sort by the class date: soonest first for upcoming, most recent first otherwise.
  const dir = scope === "upcoming" ? 1 : -1;
  rows.sort(
    (a, b) =>
      dir *
      (new Date(a.sessionStartsAt).getTime() - new Date(b.sessionStartsAt).getTime()),
  );

  return { scope, rows };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Bookings() {
  const { scope, rows } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const navigation = useNavigation();

  // Reflect the target scope immediately while the loader is in flight so the
  // button/choice-list don't snap back to the stale value during navigation.
  const pendingScope = navigation.location
    ? parseScope(new URLSearchParams(navigation.location.search).get("scope"))
    : null;
  const activeScope = pendingScope ?? scope;
  const activeLabel = SCOPE_OPTIONS.find((o) => o.scope === activeScope)!.label;

  return (
    <s-page heading="Bookings">
      <s-button
        variant="secondary"
        icon="calendar"
        accessibilityLabel="Filter by class date"
        commandFor="bookings-scope-popover"
      >
        {activeLabel}
      </s-button>
      <s-popover id="bookings-scope-popover">
        <s-box paddingBlock="small-200" paddingInline="base">
          <s-choice-list
            label="Show classes"
            name="bookings-scope"
            labelAccessibilityVisibility="exclusive"
            values={[activeScope]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (next && next !== activeScope) navigate(`/app?scope=${next}`);
            }}
          >
            {SCOPE_OPTIONS.map((option) => (
              <s-choice key={option.scope} value={option.scope}>
                {option.label}
              </s-choice>
            ))}
          </s-choice-list>
        </s-box>
      </s-popover>

      {rows.length === 0 ? (
        <s-section>
          <s-paragraph>{emptyMessage(activeScope)}</s-paragraph>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-box padding="base">
            <s-heading>
              {`${rows.length} booking${rows.length === 1 ? "" : "s"}`}
            </s-heading>
          </s-box>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Class</s-table-header>
              <s-table-header>Class date</s-table-header>
              <s-table-header>Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header listSlot="secondary">Status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={`${r.orderId}-${r.variantId}`}>
                  <s-table-cell>{r.classTitle}</s-table-cell>
                  <s-table-cell>
                    {formatSessionTitle(r.sessionStartsAt, CLASS_TIMEZONE)}
                  </s-table-cell>
                  <s-table-cell>
                    <s-link
                      href={`shopify://admin/orders/${r.orderId.split("/").pop()}`}
                      target="_top"
                    >
                      {r.orderName}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{r.customerName ?? r.email ?? "—"}</s-table-cell>
                  <s-table-cell>
                    <s-stack direction="inline" gap="small-200">
                      {r.financialStatus ? (
                        <s-badge tone={paymentTone(r.financialStatus)}>
                          {titleCase(r.financialStatus)}
                        </s-badge>
                      ) : null}
                      {r.fulfillmentStatus ? (
                        <s-badge tone={fulfillmentTone(r.fulfillmentStatus)}>
                          {titleCase(r.fulfillmentStatus)}
                        </s-badge>
                      ) : null}
                      {!r.financialStatus && !r.fulfillmentStatus ? (
                        <s-text>—</s-text>
                      ) : null}
                    </s-stack>
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

function parseScope(value: string | null): Scope | null {
  return SCOPE_OPTIONS.find((option) => option.scope === value)?.scope ?? null;
}

function emptyMessage(scope: Scope): string {
  if (scope === "upcoming") {
    return "No upcoming bookings. They appear here as customers check out on your class sessions.";
  }
  if (scope === "past") return "No past bookings.";
  return "No bookings yet. They appear here as customers check out on your class sessions.";
}

// Shopify display status enums (e.g. PARTIALLY_REFUNDED) → "Partially refunded".
function titleCase(status: string): string {
  return status
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

type BadgeTone = "success" | "info" | "warning" | "critical" | "caution" | "neutral";

function paymentTone(status: string): BadgeTone {
  switch (status) {
    case "PAID":
      return "success";
    case "PENDING":
    case "AUTHORIZED":
    case "PARTIALLY_PAID":
      return "warning";
    case "REFUNDED":
    case "PARTIALLY_REFUNDED":
      return "info";
    case "VOIDED":
    case "EXPIRED":
      return "critical";
    default:
      return "neutral";
  }
}

function fulfillmentTone(status: string): BadgeTone {
  switch (status) {
    case "FULFILLED":
      return "success";
    case "PARTIALLY_FULFILLED":
    case "IN_PROGRESS":
    case "SCHEDULED":
    case "OPEN":
      return "warning";
    case "ON_HOLD":
      return "caution";
    case "RESTOCKED":
      return "info";
    default:
      return "neutral";
  }
}
