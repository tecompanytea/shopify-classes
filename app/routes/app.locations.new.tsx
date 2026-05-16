import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { Form, redirect, useActionData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { SUPPORTED_TIMEZONES } from "../lib/timezones";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  if (!name) return { error: "Name is required." };

  const created = await db.location.create({
    data: {
      shop: session.shop,
      name,
      addressLine1: str(form.get("addressLine1")),
      addressLine2: str(form.get("addressLine2")),
      city: str(form.get("city")),
      region: str(form.get("region")),
      postalCode: str(form.get("postalCode")),
      country: str(form.get("country")),
      timezone: String(form.get("timezone") ?? "America/Los_Angeles"),
    },
  });
  return redirect(`/app/locations/${created.id}`);
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() { return boundary.error(useRouteError()); }

export default function NewLocation() {
  const actionData = useActionData<typeof action>() as { error?: string } | undefined;
  return (
    <s-page heading="New location" back-href="/app/locations">
      <s-section>
        <Form method="post">
          <s-stack direction="block" gap="base">
            {actionData?.error && <s-banner tone="critical">{actionData.error}</s-banner>}
            <s-text-field name="name" label="Name" required />
            <s-text-field name="addressLine1" label="Address line 1" />
            <s-text-field name="addressLine2" label="Address line 2" />
            <s-stack direction="inline" gap="base">
              <s-text-field name="city" label="City" />
              <s-text-field name="region" label="State / region" />
              <s-text-field name="postalCode" label="Postal code" />
            </s-stack>
            <s-text-field name="country" label="Country" />
            <s-select name="timezone" label="Timezone" value="America/Los_Angeles">
              {SUPPORTED_TIMEZONES.map((tz) => (
                <s-option key={tz.value} value={tz.value}>{tz.label}</s-option>
              ))}
            </s-select>
            <s-button type="submit" variant="primary">Save location</s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}

function str(v: FormDataEntryValue | null): string | null {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}
