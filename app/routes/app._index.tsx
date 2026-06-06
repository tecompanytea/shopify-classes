import { useState } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  useLoaderData,
  useRevalidator,
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

type SortField = "classDate" | "class" | "customer" | "location";
type SortDir = "asc" | "desc";

const SORT_OPTIONS: { label: string; field: SortField }[] = [
  { label: "Class date", field: "classDate" },
  { label: "Class", field: "class" },
  { label: "Customer", field: "customer" },
  { label: "Location", field: "location" },
];

type BookingTableRow = BookingRow & {
  classTitle: string;
  classProductHref: string;
  locationName: string | null;
  sessionStartsAt: string;
};

type LoaderResult = {
  rows: BookingTableRow[];
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderResult> => {
  const { session, admin } = await authenticate.admin(request);

  // Fetch every (non-cancelled) session + its bookings once. Scope filtering
  // (upcoming/past/all) happens client-side, so switching it never refetches.
  const sessions = await db.classSession.findMany({
    where: { shop: session.shop, cancelled: false },
    include: {
      classProduct: {
        select: {
          title: true,
          productGid: true,
          location: { select: { name: true } },
        },
      },
    },
  });

  if (sessions.length === 0) return { rows: [] };

  const variantToSession = new Map(sessions.map((s) => [s.variantGid, s]));
  const bookings = await listBookingsForVariants(admin, {
    variantGids: sessions.map((s) => s.variantGid),
    productGids: sessions.map((s) => s.classProduct.productGid),
  });

  const rows: BookingTableRow[] = [];
  for (const b of bookings) {
    const s = variantToSession.get(b.variantId);
    if (!s) continue;
    rows.push({
      ...b,
      classTitle: s.classProduct.title,
      classProductHref: `shopify://admin/products/${productNumericId(
        s.classProduct.productGid,
      )}`,
      locationName: s.classProduct.location?.name ?? null,
      sessionStartsAt: s.startsAt.toISOString(),
    });
  }

  return { rows };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Bookings() {
  const { rows } = useLoaderData<typeof loader>();
  const revalidator = useRevalidator();
  const [scope, setScope] = useState<Scope>(DEFAULT_SCOPE);
  const [scopeMenuReady, setScopeMenuReady] = useState(false);
  const [sortField, setSortField] = useState<SortField>("classDate");
  const [sortDir, setSortDir] = useState<SortDir>("asc");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [openCustomer, setOpenCustomer] = useState<number | null>(null);
  const [copiedEmail, setCopiedEmail] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const activeLabel = SCOPE_OPTIONS.find((o) => o.scope === scope)!.label;
  const isDateSort = sortField === "classDate";
  const copyEmail = async (email: string) => {
    await navigator.clipboard.writeText(email);
    setCopiedEmail(email);
    window.setTimeout(() => {
      setCopiedEmail((current) => (current === email ? null : current));
    }, 1500);
  };

  // Filter + sort client-side so switching scope/search/sort is instant (no refetch).
  const now = Date.now();
  const q = query.trim().toLowerCase();
  const visibleRows = rows
    .filter((r) => {
      const t = new Date(r.sessionStartsAt).getTime();
      if (scope === "upcoming") return t >= now;
      if (scope === "past") return t < now;
      return true;
    })
    .filter((r) =>
      q
        ? [r.classTitle, r.customerName, r.email, r.orderName].some((v) =>
            v?.toLowerCase().includes(q),
          )
        : true,
    )
    .sort((a, b) => {
      const dir = sortDir === "asc" ? 1 : -1;
      if (sortField === "classDate") {
        return (
          dir *
          (new Date(a.sessionStartsAt).getTime() -
            new Date(b.sessionStartsAt).getTime())
        );
      }
      const pick = (r: BookingTableRow) =>
        (sortField === "class"
          ? r.classTitle
          : sortField === "customer"
            ? r.customerName
            : r.locationName) ?? "";
      return dir * pick(a).localeCompare(pick(b));
    });
  const visibleRowIds = visibleRows.map(bookingRowId);
  const selectedVisibleCount = visibleRowIds.filter((id) =>
    selectedIds.includes(id),
  ).length;
  const allVisibleSelected =
    visibleRowIds.length > 0 && selectedVisibleCount === visibleRowIds.length;
  const someVisibleSelected =
    selectedVisibleCount > 0 && selectedVisibleCount < visibleRowIds.length;
  const selectVisibleRows = () => {
    setSelectedIds((current) =>
      Array.from(new Set([...current, ...visibleRowIds])),
    );
  };
  const clearSelectedRows = () => setSelectedIds([]);
  const toggleVisibleRows = () => {
    setSelectedIds((current) => {
      const visible = new Set(visibleRowIds);
      if (allVisibleSelected) return current.filter((id) => !visible.has(id));
      return Array.from(new Set([...current, ...visibleRowIds]));
    });
  };
  const toggleRow = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id)
        ? current.filter((selectedId) => selectedId !== id)
        : [...current, id],
    );
  };
  const stopRowClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
  };

  return (
    <s-page heading="Classes">
      {rows.length === 0 ? (
        <s-section>
          <s-paragraph>{emptyMessage(scope)}</s-paragraph>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            {selectedIds.length > 0 ? (
              <s-box
                slot="filters"
                padding="small"
                background="strong"
                borderRadius="base"
              >
                <s-stack direction="inline" gap="small-200" alignItems="center">
                  <s-button
                    variant="tertiary"
                    commandFor="bookings-selection-menu"
                  >
                    {selectedIds.length} selected
                  </s-button>
                  <s-menu
                    id="bookings-selection-menu"
                    accessibilityLabel="Selection actions"
                  >
                    {!allVisibleSelected ? (
                      <s-button onClick={selectVisibleRows}>
                        Select all {visibleRowIds.length} on page
                      </s-button>
                    ) : null}
                    <s-button onClick={clearSelectedRows}>Unselect all</s-button>
                  </s-menu>
                  <s-button
                    variant="secondary"
                    commandFor="bookings-mark-as-menu"
                  >
                    Mark as
                  </s-button>
                  <s-menu
                    id="bookings-mark-as-menu"
                    accessibilityLabel="Mark selected bookings as"
                  >
                    <s-button>Unfulfilled</s-button>
                    <s-button>Fulfilled</s-button>
                  </s-menu>
                </s-stack>
              </s-box>
            ) : (
              <s-stack slot="filters" direction="block" gap="small-200">
                <s-grid
                  gap="small-200"
                  gridTemplateColumns="auto auto"
                  justifyContent="space-between"
                  alignItems="center"
                >
                  <s-stack direction="inline" alignItems="center">
                    <s-clickable
                      commandFor="bookings-scope-popover"
                      paddingInline="small-200"
                      paddingBlock="small-400"
                      borderRadius="base"
                    >
                      <s-stack
                        direction="inline"
                        gap="small-400"
                        alignItems="center"
                      >
                        <s-text>{activeLabel}</s-text>
                        <s-icon type="select" />
                      </s-stack>
                    </s-clickable>
                    <s-popover
                      id="bookings-scope-popover"
                      onAfterShow={() => setScopeMenuReady(true)}
                      onAfterHide={() => setScopeMenuReady(false)}
                    >
                      <s-box padding="small-400">
                        <div
                          style={{
                            opacity: scopeMenuReady ? 1 : 0,
                          }}
                        >
                          <s-stack direction="block" gap="small-500">
                            {SCOPE_OPTIONS.map((option) => {
                              const selected = option.scope === scope;
                              return (
                                <s-clickable
                                  key={option.scope}
                                  commandFor="bookings-scope-popover"
                                  command="--hide"
                                  onClick={() => {
                                    setScope(option.scope);
                                    revalidator.revalidate();
                                  }}
                                  paddingInline="small-200"
                                  paddingBlock="small-400"
                                  borderRadius="base"
                                >
                                  <span className={styles.scopeOption}>
                                    <span
                                      className={`${styles.scopeCheck}${
                                        selected
                                          ? ` ${styles.scopeCheckSelected}`
                                          : ""
                                      }`}
                                    >
                                      <s-icon
                                        type="check"
                                        color={selected ? undefined : "subdued"}
                                      />
                                    </span>
                                    <span
                                      className={
                                        selected
                                          ? styles.scopeLabelSelected
                                          : undefined
                                      }
                                    >
                                      {option.label}
                                    </span>
                                  </span>
                                </s-clickable>
                              );
                            })}
                          </s-stack>
                        </div>
                      </s-box>
                    </s-popover>
                  </s-stack>
                  <s-stack direction="inline" gap="small-200" alignItems="center">
                    {revalidator.state === "loading" ? (
                      <s-spinner accessibilityLabel="Refreshing bookings" size="base" />
                    ) : null}
                    <s-button
                      icon="search"
                      variant="tertiary"
                      accessibilityLabel="Search"
                      onClick={() => {
                        setSearchOpen((open) => !open);
                        setQuery("");
                      }}
                    />
                    <s-button
                      icon="sort"
                      variant="tertiary"
                      accessibilityLabel="Sort"
                      commandFor="bookings-sort-popover"
                    />
                    <s-popover id="bookings-sort-popover">
                      <s-stack direction="block" gap="none">
                        <s-box padding="small">
                          <s-choice-list
                            label="Sort by"
                            name="bookings-sort-by"
                            values={[sortField]}
                            onChange={(event) => {
                              const next = event.currentTarget.values[0];
                              if (next) setSortField(next as SortField);
                            }}
                          >
                            {SORT_OPTIONS.map((option) => (
                              <s-choice key={option.field} value={option.field}>
                                {option.label}
                              </s-choice>
                            ))}
                          </s-choice-list>
                        </s-box>
                        <s-divider />
                        <s-box padding="small">
                          <s-choice-list
                            label="Order by"
                            name="bookings-order-by"
                            values={[sortDir]}
                            onChange={(event) => {
                              const next = event.currentTarget.values[0];
                              if (next === "asc" || next === "desc") setSortDir(next);
                            }}
                          >
                            <s-choice value="asc">
                              {isDateSort ? "Oldest first" : "A–Z"}
                            </s-choice>
                            <s-choice value="desc">
                              {isDateSort ? "Newest first" : "Z–A"}
                            </s-choice>
                          </s-choice-list>
                        </s-box>
                      </s-stack>
                    </s-popover>
                  </s-stack>
                </s-grid>
                {searchOpen ? (
                  <s-search-field
                    label="Search bookings"
                    labelAccessibilityVisibility="exclusive"
                    placeholder="Search by class, customer, or order"
                    value={query}
                    onInput={(event) =>
                      setQuery((event.target as HTMLInputElement).value)
                    }
                  />
                ) : null}
              </s-stack>
            )}
            <s-table-header-row>
              <s-table-header listSlot="inline">
                <s-checkbox
                  {...(allVisibleSelected ? { checked: true } : {})}
                  {...(someVisibleSelected ? { indeterminate: true } : {})}
                  {...(visibleRowIds.length === 0 ? { disabled: true } : {})}
                  accessibilityLabel="Select all bookings"
                  onChange={toggleVisibleRows}
                />
              </s-table-header>
              <s-table-header listSlot="primary">
                <span className={`${styles.nowrap} ${styles.tightClassColumn}`}>
                  Class
                </span>
              </s-table-header>
              <s-table-header listSlot="labeled">
                <span className={styles.nowrap}>Class date</span>
              </s-table-header>
              <s-table-header listSlot="labeled">
                <span className={styles.nowrap}>Order</span>
              </s-table-header>
              <s-table-header listSlot="secondary">
                <span className={styles.nowrap}>Customer</span>
              </s-table-header>
              <s-table-header format="numeric" listSlot="labeled">
                <span className={`${styles.nowrap} ${styles.tightSeatsColumn}`}>
                  Seats
                </span>
              </s-table-header>
              <s-table-header listSlot="labeled">
                <span className={styles.nowrap}>Location</span>
              </s-table-header>
              <s-table-header listSlot="labeled">
                <span className={styles.nowrap}>Fulfillment status</span>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {visibleRows.map((r, i) => {
                const selectedId = bookingRowId(r);
                const checkboxId = `booking-row-${i}-checkbox`;
                const selected = selectedIds.includes(selectedId);

                return (
                  <s-table-row key={selectedId} clickDelegate={checkboxId}>
                    <s-table-cell>
                      <s-checkbox
                        id={checkboxId}
                        {...(selected ? { checked: true } : {})}
                        accessibilityLabel={`Select booking for ${r.classTitle}`}
                        onChange={() => toggleRow(selectedId)}
                      />
                    </s-table-cell>
                    <s-table-cell>
                      <button
                        type="button"
                        className={`${styles.orderNumber} ${styles.tightClassColumn}`}
                        onClick={(event) => {
                          stopRowClick(event);
                          document
                            .getElementById(`class-product-link-${i}`)
                            ?.click();
                        }}
                      >
                        {r.classTitle}
                      </button>
                      <span className={styles.srOnly}>
                        <s-link
                          id={`class-product-link-${i}`}
                          href={r.classProductHref}
                          target="_top"
                          onClick={stopRowClick}
                        >
                          {`Open product ${r.classTitle}`}
                        </s-link>
                      </span>
                    </s-table-cell>
                    <s-table-cell>
                      {formatBookingDate(r.sessionStartsAt, CLASS_TIMEZONE)}
                    </s-table-cell>
                    <s-table-cell>
                      <button
                        type="button"
                        className={styles.orderNumber}
                        onClick={(event) => {
                          stopRowClick(event);
                          document.getElementById(`order-link-${i}`)?.click();
                        }}
                      >
                        {r.orderName}
                      </button>
                      <span className={styles.srOnly}>
                        <s-link
                          id={`order-link-${i}`}
                          href={`shopify://admin/orders/${r.orderId.split("/").pop()}`}
                          target="_top"
                          onClick={stopRowClick}
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
                            onClick={stopRowClick}
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
                              <s-stack
                                direction="block"
                                gap="small"
                                alignItems="stretch"
                              >
                                <s-stack direction="block" gap="small-500">
                                  <s-heading>
                                    {r.customerName ?? "Customer"}
                                  </s-heading>
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
                                        {r.customerOrdersCount === 1
                                          ? "order"
                                          : "orders"}
                                      </span>
                                    </s-paragraph>
                                  ) : null}
                                </s-stack>
                                {r.email ? (
                                  <s-stack
                                    direction="block"
                                    gap="small"
                                    alignItems="stretch"
                                  >
                                    <s-stack
                                      direction="inline"
                                      justifyContent="space-between"
                                      alignItems="center"
                                      gap="base"
                                    >
                                      <s-link
                                        href={`mailto:${r.email}`}
                                        onClick={stopRowClick}
                                      >
                                        <span className={styles.popoverLine}>
                                          {r.email}
                                        </span>
                                      </s-link>
                                      <s-tooltip id={`copy-email-${i}`}>
                                        Copy email
                                      </s-tooltip>
                                      <s-button
                                        variant="tertiary"
                                        icon={
                                          copiedEmail === r.email
                                            ? "check"
                                            : "clipboard"
                                        }
                                        accessibilityLabel={`Copy email ${r.email}`}
                                        interestFor={`copy-email-${i}`}
                                        onClick={(event) => {
                                          stopRowClick(event);
                                          copyEmail(r.email!);
                                        }}
                                      />
                                    </s-stack>
                                    <s-button
                                      variant="secondary"
                                      href={`shopify://admin/customers/${r.customerId.split("/").pop()}`}
                                      target="_top"
                                      onClick={stopRowClick}
                                    >
                                      View customer
                                    </s-button>
                                  </s-stack>
                                ) : (
                                  <s-button
                                    variant="secondary"
                                    href={`shopify://admin/customers/${r.customerId.split("/").pop()}`}
                                    target="_top"
                                    onClick={stopRowClick}
                                  >
                                    View customer
                                  </s-button>
                                )}
                              </s-stack>
                            </s-box>
                          </s-popover>
                        </>
                      ) : (
                        r.customerName ?? r.email ?? "—"
                      )}
                    </s-table-cell>
                    <s-table-cell>
                      <span className={styles.tightSeatsColumn}>{r.quantity}</span>
                    </s-table-cell>
                    <s-table-cell>
                      {r.locationName ?? "—"}
                    </s-table-cell>
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
                );
              })}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}

function emptyMessage(scope: Scope): string {
  if (scope === "upcoming") {
    return "No upcoming bookings. They appear here as customers check out on your class sessions.";
  }
  if (scope === "past") return "No past bookings.";
  return "No bookings yet. They appear here as customers check out on your class sessions.";
}

function bookingRowId(row: BookingTableRow): string {
  return `${row.orderId}:${row.lineItemId}`;
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

function productNumericId(gid: string): string {
  return gid.split("/").pop() ?? "";
}
