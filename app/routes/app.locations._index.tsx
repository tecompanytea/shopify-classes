import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Link, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const locations = await db.location.findMany({
    where: { shop: session.shop, archived: false },
    orderBy: { name: "asc" },
  });
  return { locations };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function LocationsIndex() {
  const { locations } = useLoaderData<typeof loader>();
  return (
    <s-page heading="Locations" back-href="/app">
      <s-stack direction="inline" gap="base">
        <s-button href="/app/locations/new" variant="primary">
          New location
        </s-button>
      </s-stack>

      {locations.length === 0 ? (
        <s-section>
          <s-paragraph>
            Locations are the human-readable venue strings that show up on the
            class product. They are separate from Shopify&apos;s inventory
            locations.
          </s-paragraph>
        </s-section>
      ) : (
        <s-section
          heading={`${locations.length} location${locations.length === 1 ? "" : "s"}`}
        >
          <s-stack direction="block" gap="base">
            {locations.map((l) => (
              <s-stack key={l.id} direction="inline" gap="base">
                <Link to={`/app/locations/${l.id}`}>
                  <s-text>
                    <strong>{l.name}</strong>
                  </s-text>
                </Link>
                <s-text tone="neutral">
                  {[l.city, l.region].filter(Boolean).join(", ") || "—"}
                </s-text>
                <s-text tone="neutral">{l.timezone}</s-text>
              </s-stack>
            ))}
          </s-stack>
        </s-section>
      )}
    </s-page>
  );
}
