import { useState } from "react";
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
import { formatBookingDate } from "../lib/sku";
import styles from "../booking-table.module.css";

type Scope = "upcoming" | "past" | "all";

const SCOPE_OPTIONS: { label: string; scope: Scope }[] = [
  { label: "Upcoming", scope: "upcoming" },
  { label: "Past", scope: "past" },
  { label: "All", scope: "all" },
];

const DEFAULT_SCOPE: Scope = "upcoming";

type BookingTableRow = BookingRow & {
  classTitle: string;
  locationName: string | null;
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
    include: {
      classProduct: {
        select: { title: true, location: { select: { name: true } } },
      },
    },
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
      locationName: s.classProduct.location?.name ?? null,
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
  const [query, setQuery] = useState("");
  const [openCustomer, setOpenCustomer] = useState<number | null>(null);

  // Reflect the target scope immediately while the loader is in flight so the
  // button/choice-list don't snap back to the stale value during navigation.
  const pendingScope = navigation.location
    ? parseScope(new URLSearchParams(navigation.location.search).get("scope"))
    : null;
  const activeScope = pendingScope ?? scope;
  const activeLabel = SCOPE_OPTIONS.find((o) => o.scope === activeScope)!.label;

  const q = query.trim().toLowerCase();
  const visibleRows = q
    ? rows.filter((r) =>
        [r.classTitle, r.customerName, r.email, r.orderName].some((v) =>
          v?.toLowerCase().includes(q),
        ),
      )
    : rows;

  const scopeButton = (
    <s-button
      variant="secondary"
      icon="calendar"
      accessibilityLabel="Filter by class date"
      commandFor="bookings-scope-popover"
    >
      {activeLabel}
    </s-button>
  );
  const scopePopover = (
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
  );

  return (
    <s-page heading="Bookings">
      <s-box paddingBlockEnd="base">
        {scopeButton}
        {scopePopover}
      </s-box>
      {rows.length === 0 ? (
        <s-section>
          <s-paragraph>{emptyMessage(activeScope)}</s-paragraph>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-search-field
              slot="filters"
              label="Search bookings"
              labelAccessibilityVisibility="exclusive"
              placeholder="Search by class, customer, or order"
              value={query}
              onInput={(e) => setQuery((e.target as HTMLInputElement).value)}
            />
            <s-table-header-row>
              <s-table-header listSlot="primary">Class</s-table-header>
              <s-table-header listSlot="labeled">Class date</s-table-header>
              <s-table-header listSlot="labeled">Order</s-table-header>
              <s-table-header listSlot="secondary">Customer</s-table-header>
              <s-table-header format="numeric" listSlot="labeled">Seats</s-table-header>
              <s-table-header listSlot="labeled">Location</s-table-header>
              <s-table-header listSlot="labeled">Fulfillment status</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {visibleRows.map((r, i) => (
                <s-table-row key={`${r.orderId}-${r.variantId}`}>
                  <s-table-cell>{r.classTitle}</s-table-cell>
                  <s-table-cell>
                    {formatBookingDate(r.sessionStartsAt, CLASS_TIMEZONE)}
                  </s-table-cell>
                  <s-table-cell>
                    <div
                      className={styles.orderNumber}
                      onClick={() =>
                        document.getElementById(`order-link-${i}`)?.click()
                      }
                    >
                      {r.orderName}
                    </div>
                    <span className={styles.srOnly}>
                      <s-link
                        id={`order-link-${i}`}
                        href={`shopify://admin/orders/${r.orderId.split("/").pop()}`}
                        target="_top"
                      >
                        {`Open order ${r.orderName}`}
                      </s-link>
                    </span>
                  </s-table-cell>
                  <s-table-cell>
                    {r.customerId ? (
                      <>
                        <button
                          type="button"
                          className={`${styles.customerActivator}${
                            openCustomer === i ? ` ${styles.open}` : ""
                          }`}
                          {...({
                            commandfor: `customer-${i}`,
                            command: "--toggle",
                          } as Record<string, string>)}
                        >
                          <span className={styles.customerName}>
                            {r.customerName ?? r.email ?? "View customer"}
                          </span>
                          <s-icon type="caret-down" size="base" color="base" />
                        </button>
                        <s-popover
                          id={`customer-${i}`}
                          minInlineSize="250px"
                          onShow={() => setOpenCustomer(i)}
                          onHide={() => setOpenCustomer(null)}
                        >
                          <s-box padding="small">
                            <s-stack direction="block" gap="small">
                              <s-stack direction="block" gap="small-500">
                                <s-heading>{r.customerName ?? "Customer"}</s-heading>
                                {r.customerLocation ? (
                                  <s-paragraph>
                                    <span className={styles.popoverLine}>
                                      {r.customerLocation}
                                    </span>
                                  </s-paragraph>
                                ) : null}
                                {r.customerOrdersCount != null ? (
                                  <s-paragraph>
                                    <span className={styles.popoverLine}>
                                      {r.customerOrdersCount}{" "}
                                      {r.customerOrdersCount === 1 ? "order" : "orders"}
                                    </span>
                                  </s-paragraph>
                                ) : null}
                              </s-stack>
                              {r.email ? (
                                <s-link href={`mailto:${r.email}`}>
                                  <span className={styles.popoverLine}>{r.email}</span>
                                </s-link>
                              ) : null}
                              <s-button
                                variant="secondary"
                                inlineSize="fill"
                                href={`shopify://admin/customers/${r.customerId.split("/").pop()}`}
                                target="_top"
                              >
                                View customer
                              </s-button>
                            </s-stack>
                          </s-box>
                        </s-popover>
                      </>
                    ) : (
                      r.customerName ?? r.email ?? "—"
                    )}
                  </s-table-cell>
                  <s-table-cell>{r.quantity}</s-table-cell>
                  <s-table-cell>{r.locationName ?? "—"}</s-table-cell>
                  <s-table-cell>
                    {r.fulfillmentStatus ? (
                      <s-badge
                        tone={fulfillmentTone(r.fulfillmentStatus)}
                        icon={fulfillmentIcon(r.fulfillmentStatus)}
                      >
                        {titleCase(r.fulfillmentStatus)}
                      </s-badge>
                    ) : (
                      "—"
                    )}
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

// Fulfilled = done → no tone, just the icon. On hold is the problem state (warning);
// everything else still "to do" gets the softer caution.
function fulfillmentTone(status: string): BadgeTone | undefined {
  switch (status) {
    case "FULFILLED":
      return undefined;
    case "ON_HOLD":
      return "warning";
    case "UNFULFILLED":
    case "PARTIALLY_FULFILLED":
    case "IN_PROGRESS":
    case "SCHEDULED":
    case "OPEN":
      return "caution";
    case "RESTOCKED":
      return "info";
    default:
      return "neutral";
  }
}

// enabled = done; incomplete = not done yet (including on hold).
function fulfillmentIcon(status: string): "" | "enabled" | "incomplete" {
  switch (status) {
    case "FULFILLED":
      return "enabled";
    case "UNFULFILLED":
    case "PARTIALLY_FULFILLED":
    case "IN_PROGRESS":
    case "SCHEDULED":
    case "OPEN":
    case "ON_HOLD":
      return "incomplete";
    default:
      return "";
  }
}
