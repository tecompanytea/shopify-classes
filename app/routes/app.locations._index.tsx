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
    address: location.addressLine1 ?? "-",
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
    <s-page heading="Locations">
      <s-button slot="primary-action" href="/app/locations/new">
        Add location
      </s-button>

      {rows.length === 0 ? (
        <s-section accessibilityLabel="Empty state">
          <s-stack
            direction="block"
            alignItems="center"
            gap="base"
            paddingBlock="large-400"
            maxInlineSize="450px"
          >
            <s-heading>Set up your first location</s-heading>
            <s-paragraph>
              Add the human-readable venue details that appear on event pages
              and confirmation emails. Locations are separate from Shopify
              inventory locations.
            </s-paragraph>
            <s-button href="/app/locations/new" variant="primary">
              Add location
            </s-button>
          </s-stack>
        </s-section>
      ) : (
        <s-section padding="none">
          <s-table>
            <s-table-header-row>
              <s-table-header listSlot="primary">Location</s-table-header>
              <s-table-header listSlot="secondary">Address</s-table-header>
              <s-table-header listSlot="labeled">
                <s-stack alignItems="center">Events</s-stack>
              </s-table-header>
            </s-table-header-row>
            <s-table-body>
              {rows.map((row) => {
                const locationLinkId = `location-link-${row.id}`;

                return (
                  <s-table-row key={row.id} clickDelegate={locationLinkId}>
                    <s-table-cell>
                      <s-text>{row.name}</s-text>
                      <s-link
                        id={locationLinkId}
                        href={`/app/locations/${row.id}`}
                        accessibilityLabel={`View ${row.name}`}
                      />
                    </s-table-cell>
                    <s-table-cell>{row.address}</s-table-cell>
                    <s-table-cell>
                      <s-stack alignItems="center">{row.eventCount}</s-stack>
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
