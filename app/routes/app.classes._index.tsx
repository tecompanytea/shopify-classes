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
    <s-page heading="Classes" back-href="/app">
      <s-button slot="primary-action" href="/app/classes/new" variant="primary">
        Create class
      </s-button>

      {rows.length === 0 ? (
        <s-section>
          <s-grid
            gridTemplateColumns="repeat(12, 1fr)"
            gap="large-300"
            alignItems="center"
            justifyItems="stretch"
            inlineSize="100%"
          >
            <s-grid-item gridColumn="span 6">
              <s-box inlineSize="100%" maxInlineSize="640px">
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

            <s-grid-item gridColumn="span 6">
              <s-box
                accessibilityVisibility="hidden"
                inlineSize="100%"
                maxInlineSize="520px"
              >
                <s-image
                  src="/te-classes-empty-state.jpg"
                  alt=""
                  accessibilityRole="presentation"
                  aspectRatio="1427/1070"
                  inlineSize="fill"
                  objectFit="contain"
                />
              </s-box>
            </s-grid-item>
          </s-grid>
        </s-section>
      ) : (
        <s-section heading={`${rows.length} class${rows.length === 1 ? "" : "es"}`} padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Class</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header>Location</s-table-header>
              <s-table-header format="numeric">Upcoming</s-table-header>
              <s-table-header listSlot="secondary">Next session</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => {
                const classLinkId = `class-link-${row.id}`;

                return (
                  <s-table-row key={row.id} clickDelegate={classLinkId}>
                    <s-table-cell>
                      <Link id={classLinkId} to={`/app/classes/${row.id}`}>
                        {row.title}
                      </Link>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge tone={row.status === "active" ? "success" : undefined}>
                        {row.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.locationName ?? "-"}</s-table-cell>
                    <s-table-cell>{row.upcomingSessionCount}</s-table-cell>
                    <s-table-cell>
                      {row.nextSessionAt
                        ? new Date(row.nextSessionAt).toLocaleString(undefined, {
                            weekday: "short",
                            month: "short",
                            day: "numeric",
                            hour: "numeric",
                            minute: "2-digit",
                            timeZone: row.timezone,
                          })
                        : "-"}
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
