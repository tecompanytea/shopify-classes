import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { listBookingsForVariants, type BookingRow } from "../.server/shopify/orders";
import { formatSessionTitle } from "../lib/sku";

type LoaderResult = {
  rows: (BookingRow & {
    classTitle: string | null;
    sessionStartsAt: string | null;
    timezone: string | null;
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
      timezone: s?.timezone ?? null,
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
            class variants.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section heading={`${rows.length} line item${rows.length === 1 ? "" : "s"}`}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                <th style={th}>Order</th>
                <th style={th}>Customer</th>
                <th style={th}>Class</th>
                <th style={th}>Session</th>
                <th style={th}>Qty</th>
                <th style={th}>Payment</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.orderId}-${r.variantId}`} style={{ borderBottom: "1px solid #f1f1f1" }}>
                  <td style={td}>
                    <a
                      href={`shopify://admin/orders/${r.orderId.split("/").pop()}`}
                      target="_top"
                    >
                      {r.orderName}
                    </a>
                  </td>
                  <td style={td}>{r.customerName ?? r.email ?? "—"}</td>
                  <td style={td}>{r.classTitle ?? r.title}</td>
                  <td style={td}>
                    {r.sessionStartsAt && r.timezone
                      ? formatSessionTitle(r.sessionStartsAt, r.timezone)
                      : r.variantTitle ?? "—"}
                  </td>
                  <td style={td}>{r.quantity}</td>
                  <td style={td}>{r.financialStatus ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </s-section>
      )}
    </s-page>
  );
}

const th: React.CSSProperties = {
  padding: "0.6rem 0.5rem",
  fontSize: "0.78rem",
  fontWeight: 500,
  color: "#6d7175",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const td: React.CSSProperties = { padding: "0.65rem 0.5rem", fontSize: "0.9rem" };
