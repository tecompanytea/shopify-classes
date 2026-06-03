import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { getOrCreateShopSettings } from "../lib/settings.server";
import { CLASS_TIMEZONE } from "../lib/class-config";
import styles from "../booking-table.module.css";

type ClassRow = {
  id: string;
  title: string;
  status: string;
  locationName: string | null;
  durationMin: number;
  defaultCapacity: number;
  sessionCount: number;
  upcomingSessionCount: number;
  nextSessionAt: string | null;
  href: string;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  await getOrCreateShopSettings(session.shop);
  const appBaseHref = shopifyAdminAppHref(session.shop);

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
      durationMin: c.durationMin,
      defaultCapacity: c.defaultCapacity,
      sessionCount: c.sessions.length,
      upcomingSessionCount: upcoming.length,
      nextSessionAt: upcoming[0]?.startsAt.toISOString() ?? null,
      href: `${appBaseHref}/app/classes/${c.id}`,
    };
  });

  return { rows, createEventHref: `${appBaseHref}/app/classes/new` };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function ClassesIndex() {
  const { rows, createEventHref } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Events">
      <s-link slot="breadcrumb-actions" href="/app">
        Classes
      </s-link>

      {rows.length > 0 && (
        <s-button
          slot="primary-action"
          href={createEventHref}
          target="_top"
          variant="primary"
        >
          Create event
        </s-button>
      )}

      {rows.length === 0 ? (
        <s-section accessibilityLabel="Empty state section">
          <s-grid gap="base" justifyItems="center" paddingBlock="base">
            <s-box maxInlineSize="280px" maxBlockSize="210px">
              <s-image
                src="/te-classes-empty-state.jpg"
                alt="A teapot in front of an event calendar"
                aspectRatio="1427/1070"
                inlineSize="fill"
                objectFit="contain"
              />
            </s-box>
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              <s-stack direction="block" alignItems="center" gap="base">
                <s-heading>Set up your first event</s-heading>
                <s-paragraph>
                  Pick an existing Shopify product, add dates, capacity, and
                  location. Customers can then view real-time event availability
                  and check out through Shopify.
                </s-paragraph>
              </s-stack>
              <s-button href={createEventHref} target="_top" variant="primary">
                Create event
              </s-button>
            </s-grid>
          </s-grid>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Event</s-table-header>
              <s-table-header listSlot="inline">Status</s-table-header>
              <s-table-header listSlot="secondary">Location</s-table-header>
              <s-table-header format="numeric" listSlot="labeled">
                Upcoming
              </s-table-header>
              <s-table-header listSlot="labeled">Next session</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => {
                const classLinkId = `class-link-${row.id}`;
                const classDetailLinkId = `class-detail-link-${row.id}`;

                return (
                  <s-table-row key={row.id} clickDelegate={classDetailLinkId}>
                    <s-table-cell>
                      <button
                        id={classLinkId}
                        type="button"
                        className={styles.orderNumber}
                        onClick={() =>
                          document.getElementById(classDetailLinkId)?.click()
                        }
                      >
                        {row.title}
                      </button>
                      <span className={styles.srOnly}>
                        <s-link
                          id={classDetailLinkId}
                          href={row.href}
                          target="_top"
                        >
                          {`Open event ${row.title}`}
                        </s-link>
                      </span>
                    </s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={row.status === "active" ? "success" : undefined}
                      >
                        {row.status}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>{row.locationName ?? "-"}</s-table-cell>
                    <s-table-cell>{row.upcomingSessionCount}</s-table-cell>
                    <s-table-cell>
                      {row.nextSessionAt
                        ? new Date(row.nextSessionAt).toLocaleString(
                            undefined,
                            {
                              weekday: "short",
                              month: "short",
                              day: "numeric",
                              hour: "numeric",
                              minute: "2-digit",
                              timeZone: CLASS_TIMEZONE,
                            },
                          )
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

function shopifyAdminAppHref(shop: string): string {
  const storeHandle = shop.replace(/\.myshopify\.com$/i, "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "classes";
  return `https://admin.shopify.com/store/${encodeURIComponent(storeHandle)}/apps/${encodeURIComponent(appHandle)}`;
}
