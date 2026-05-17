import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";

type LocationRow = {
  id: string;
  name: string;
  address: string;
  eventCount: number;
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const locations = await db.location.findMany({
    where: { shop: session.shop, archived: false },
    include: {
      _count: {
        select: { classProducts: true },
      },
    },
    orderBy: { name: "asc" },
  });

  const rows: LocationRow[] = locations.map((location) => ({
    id: location.id,
    name: location.name,
    address: formatAddress([
      location.addressLine1,
      location.addressLine2,
      location.city,
      location.region,
      location.postalCode,
      location.country,
    ]),
    eventCount: location._count.classProducts,
  }));

  return { rows };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function LocationsIndex() {
  const { rows } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Locations" back-href="/app">
      {rows.length === 0 ? (
        <s-section accessibilityLabel="Empty state section">
          <s-grid gap="base" justifyItems="center" paddingBlock="large-400">
            <s-grid justifyItems="center" maxInlineSize="450px" gap="base">
              <s-stack direction="block" alignItems="center" gap="base">
                <s-heading>Set up your first location</s-heading>
                <s-paragraph>
                  Add the human-readable venue details that appear on event
                  pages and confirmation emails. Locations are separate from
                  Shopify inventory locations.
                </s-paragraph>
              </s-stack>
              <s-button href="/app/locations/new" variant="primary">
                Create location
              </s-button>
            </s-grid>
          </s-grid>
        </s-section>
      ) : (
        <>
          <s-stack direction="inline" gap="base">
            <s-button href="/app/locations/new" variant="primary">
              Create location
            </s-button>
          </s-stack>

          <s-section
            heading={`${rows.length} location${rows.length === 1 ? "" : "s"}`}
            padding="none"
          >
            <s-table>
              <s-table-header-row>
                <s-table-header listSlot="primary">Location</s-table-header>
                <s-table-header listSlot="inline">Status</s-table-header>
                <s-table-header>Address</s-table-header>
                <s-table-header format="numeric">Events</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {rows.map((row) => {
                  const locationLinkId = `location-link-${row.id}`;

                  return (
                    <s-table-row key={row.id} clickDelegate={locationLinkId}>
                      <s-table-cell>
                        <s-link
                          id={locationLinkId}
                          href={`/app/locations/${row.id}`}
                        >
                          {row.name}
                        </s-link>
                      </s-table-cell>
                      <s-table-cell>
                        <s-badge tone="success">Enabled</s-badge>
                      </s-table-cell>
                      <s-table-cell>{row.address}</s-table-cell>
                      <s-table-cell>{row.eventCount}</s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-section>
        </>
      )}
    </s-page>
  );
}

function formatAddress(parts: Array<string | null>): string {
  return parts.filter(Boolean).join(", ") || "-";
}
