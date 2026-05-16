import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/settings.server";

type ClassRow = {
  id: string;
  title: string;
  status: string;
  locationName: string | null;
  timezone: string;
  durationMin: number;
  defaultCapacity: number;
  sessionCount: number;
  upcomingSessionCount: number;
  nextSessionAt: string | null;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await getOrCreateShopSettings(session.shop);

  const classes = await db.classProduct.findMany({
    where: { shop: session.shop },
    include: {
      location: true,
      sessions: {
        select: { id: true, startsAt: true, cancelled: true },
      },
    },
    orderBy: { updatedAt: "desc" },
  });

  const now = new Date();
  const rows: ClassRow[] = classes.map((c) => {
    const upcoming = c.sessions
      .filter((s) => !s.cancelled && s.startsAt > now)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    return {
      id: c.id,
      title: c.title,
      status: c.status,
      locationName: c.location?.name ?? null,
      timezone: c.timezone,
      durationMin: c.durationMin,
      defaultCapacity: c.defaultCapacity,
      sessionCount: c.sessions.length,
      upcomingSessionCount: upcoming.length,
      nextSessionAt: upcoming[0]?.startsAt.toISOString() ?? null,
    };
  });

  return { rows };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function ClassesIndex() {
  const { rows } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Classes">
      {rows.length === 0 ? (
        <s-section>
          <s-grid
            gridTemplateColumns="minmax(0, 1fr) minmax(280px, 520px)"
            gap="large-300"
            alignItems="center"
            inlineSize="100%"
          >
            <s-grid-item gridColumn="auto">
              <s-box maxInlineSize="640px">
                <s-stack direction="block" gap="base">
                  <s-heading>Set up your first class</s-heading>
                  <s-paragraph>
                    Pick an existing Shopify product, add dates, capacity,
                    location, and pricing. Customers can then view real-time
                    class availability and check out through Shopify.
                  </s-paragraph>
                  <s-button href="/app/classes/new" variant="primary">
                    Create class
                  </s-button>
                </s-stack>
              </s-box>
            </s-grid-item>

            <s-grid-item gridColumn="auto">
              <s-box
                accessibilityVisibility="hidden"
                inlineSize="100%"
              >
                <s-image
                  src="/te-classes-empty-state.png"
                  alt=""
                  accessibilityRole="presentation"
                  aspectRatio="1586/992"
                  inlineSize="fill"
                  objectFit="contain"
                />
              </s-box>
            </s-grid-item>
          </s-grid>
        </s-section>
      ) : (
        <s-section heading={`${rows.length} class${rows.length === 1 ? "" : "es"}`}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid var(--s-color-border, #e1e3e5)" }}>
                <th style={cellHead}>Class</th>
                <th style={cellHead}>Status</th>
                <th style={cellHead}>Location</th>
                <th style={cellHead}>Upcoming</th>
                <th style={cellHead}>Next session</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderBottom: "1px solid var(--s-color-border, #f1f1f1)" }}>
                  <td style={cell}>
                    <Link to={`/app/classes/${row.id}`}>{row.title}</Link>
                  </td>
                  <td style={cell}>
                    <s-badge tone={row.status === "active" ? "success" : undefined}>
                      {row.status}
                    </s-badge>
                  </td>
                  <td style={cell}>{row.locationName ?? "—"}</td>
                  <td style={cell}>{row.upcomingSessionCount}</td>
                  <td style={cell}>
                    {row.nextSessionAt
                      ? new Date(row.nextSessionAt).toLocaleString(undefined, {
                          weekday: "short",
                          month: "short",
                          day: "numeric",
                          hour: "numeric",
                          minute: "2-digit",
                          timeZone: row.timezone,
                        })
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </s-section>
      )}
    </s-page>
  );
}

const cellHead: React.CSSProperties = {
  padding: "0.6rem 0.5rem",
  fontSize: "0.78rem",
  fontWeight: 500,
  color: "var(--s-color-text-subdued, #6d7175)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
};
const cell: React.CSSProperties = { padding: "0.65rem 0.5rem", fontSize: "0.9rem" };
