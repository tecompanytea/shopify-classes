import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, redirect, useActionData, useLoaderData, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { SUPPORTED_TIMEZONES } from "../lib/timezones";

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const location = await db.location.findFirst({
    where: { id: String(params.id), shop: session.shop },
    include: { classProducts: true },
  });
  if (!location) throw new Response("Not found", { status: 404 });
  return { location };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "archive") {
    await db.location.update({
      where: { id: String(params.id) },
      data: { archived: true },
    });
    return redirect("/app/locations");
  }

  await db.location.update({
    where: { id: String(params.id) },
    data: {
      name: String(form.get("name") ?? "").trim(),
      addressLine1: str(form.get("addressLine1")),
      addressLine2: str(form.get("addressLine2")),
      city: str(form.get("city")),
      region: str(form.get("region")),
      postalCode: str(form.get("postalCode")),
      country: str(form.get("country")),
      timezone: String(form.get("timezone") ?? "America/Los_Angeles"),
    },
  });
  void session;
  return { ok: true };
};

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);
export function ErrorBoundary() { return boundary.error(useRouteError()); }

export default function EditLocation() {
  const { location } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { ok?: boolean } | undefined;

  return (
    <s-page heading={location.name} back-href="/app/locations">
      <s-section heading="Details">
        {actionData?.ok && <s-banner tone="success">Saved.</s-banner>}
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-text-field name="name" label="Name" defaultValue={location.name} required />
            <s-text-field name="addressLine1" label="Address line 1" defaultValue={location.addressLine1 ?? ""} />
            <s-text-field name="addressLine2" label="Address line 2" defaultValue={location.addressLine2 ?? ""} />
            <s-stack direction="inline" gap="base">
              <s-text-field name="city" label="City" defaultValue={location.city ?? ""} />
              <s-text-field name="region" label="State / region" defaultValue={location.region ?? ""} />
              <s-text-field name="postalCode" label="Postal code" defaultValue={location.postalCode ?? ""} />
            </s-stack>
            <s-text-field name="country" label="Country" defaultValue={location.country ?? ""} />
            <s-select name="timezone" label="Timezone" value={location.timezone}>
              {SUPPORTED_TIMEZONES.map((tz) => (
                <s-option key={tz.value} value={tz.value}>{tz.label}</s-option>
              ))}
            </s-select>
            <s-button type="submit" variant="primary">Save</s-button>
          </s-stack>
        </Form>
      </s-section>

      <s-section heading={`Classes using this location · ${location.classProducts.length}`}>
        {location.classProducts.length === 0 ? (
          <s-text tone="neutral">None.</s-text>
        ) : (
          <s-stack direction="block" gap="base">
            {location.classProducts.map((c) => (
              <s-text key={c.id}>{c.title}</s-text>
            ))}
          </s-stack>
        )}
      </s-section>

      <s-section heading="Archive">
        <Form method="post">
          <input type="hidden" name="intent" value="archive" />
          <s-button type="submit" tone="critical">Archive location</s-button>
        </Form>
      </s-section>
    </s-page>
  );
}

function str(v: FormDataEntryValue | null): string | null {
  const s = (v ?? "").toString().trim();
  return s ? s : null;
}
