import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listBookingsForVariants, type BookingRow } from "../.server/shopify/orders";
import { CLASS_TIMEZONE } from "../lib/class-config";
import { formatSessionTitle } from "../lib/sku";

type LoaderResult = {
  rows: (BookingRow & {
    classTitle: string | null;
    sessionStartsAt: string | null;
  })[];
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<LoaderResult> => {
  const { session, admin } = await authenticate.admin(request);

  const sessions = await db.classSession.findMany({
    where: { shop: session.shop, cancelled: false },
    include: { classProduct: { select: { title: true } } },
    orderBy: { startsAt: "desc" },
  });

  if (sessions.length === 0) return { rows: [] };

  const variantToSession = new Map(sessions.map((s) => [s.variantGid, s]));
  const bookings = await listBookingsForVariants(admin, {
    variantGids: sessions.map((s) => s.variantGid),
  });

  const rows = bookings.map((b) => {
    const s = variantToSession.get(b.variantId);
    return {
      ...b,
      classTitle: s?.classProduct.title ?? null,
      sessionStartsAt: s ? s.startsAt.toISOString() : null,
    };
  });

  return { rows };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() { return boundary.error(useRouteError()); }

export default function Bookings() {
  const { rows } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Bookings" back-href="/app">
      {rows.length === 0 ? (
        <s-section>
          <s-paragraph>
            No bookings yet. Bookings appear here as Shopify orders are placed on
            event variants.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading={`${rows.length} line item${rows.length === 1 ? "" : "s"}`}>
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Order</s-table-header>
              <s-table-header>Customer</s-table-header>
              <s-table-header>Event</s-table-header>
              <s-table-header>Session</s-table-header>
              <s-table-header format="numeric">Qty</s-table-header>
              <s-table-header listSlot="secondary">Payment</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((r) => (
                <s-table-row key={`${r.orderId}-${r.variantId}`}>
                  <s-table-cell>
                    <s-link
                      href={`shopify://admin/orders/${r.orderId.split("/").pop()}`}
                      target="_top"
                    >
                      {r.orderName}
                    </s-link>
                  </s-table-cell>
                  <s-table-cell>{r.customerName ?? r.email ?? "—"}</s-table-cell>
                  <s-table-cell>{r.classTitle ?? r.title}</s-table-cell>
                  <s-table-cell>
                    {r.sessionStartsAt
                      ? formatSessionTitle(r.sessionStartsAt, CLASS_TIMEZONE)
                      : r.variantTitle ?? "—"}
                  </s-table-cell>
                  <s-table-cell>{r.quantity}</s-table-cell>
                  <s-table-cell>{r.financialStatus ?? "—"}</s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        </s-section>
      )}
    </s-page>
  );
}
