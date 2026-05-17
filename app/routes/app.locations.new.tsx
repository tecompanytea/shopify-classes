import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  COUNTRY_OPTIONS,
  defaultLocationFormValues,
  findInvalidEmail,
  normalizeEmailList,
  nullable,
  readLocationFormValues,
  type LocationFormValues,
} from "../lib/location-form";

type ActionData = {
  error?: string;
  values?: LocationFormValues;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const values = readLocationFormValues(form);

  if (!values.name) return { error: "Location name is required.", values };

  const invalidEmail = findInvalidEmail(values.bookingNotificationEmails);
  if (invalidEmail) {
    return { error: `Check the email address: ${invalidEmail}`, values };
  }

  const created = await db.location.create({
    data: {
      shop: session.shop,
      name: values.name,
      addressLine1: nullable(values.addressLine1),
      addressLine2: nullable(values.addressLine2),
      city: nullable(values.city),
      region: nullable(values.region),
      postalCode: nullable(values.postalCode),
      country: nullable(values.country),
      timezone: values.timezone,
      bookingNotificationEmails: normalizeEmailList(
        values.bookingNotificationEmails,
      ),
      archived: values.status === "disabled",
    },
  });
  return redirect(`/app/locations/${created.id}`);
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function NewLocation() {
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const values = actionData?.values ?? defaultLocationFormValues;
  const saving = navigation.state !== "idle";

  return (
    <Form method="post">
      <s-page heading="Create new location" back-href="/app/locations">
        <s-button
          slot="primary-action"
          type="submit"
          variant="primary"
          loading={saving ? true : undefined}
        >
          Save
        </s-button>

        <s-grid gridTemplateColumns="minmax(0, 2fr) minmax(280px, 1fr)" gap="large-300">
          <s-stack direction="block" gap="large-300">
            {actionData?.error && (
              <s-banner tone="critical">{actionData.error}</s-banner>
            )}

            <s-section heading="Location Information">
              <s-stack direction="block" gap="base">
                <s-text-field
                  name="name"
                  label="Location name"
                  placeholder="Enter your branch name / location name"
                  defaultValue={values.name}
                  required
                />

                <s-select name="country" label="Country" value={values.country}>
                  {COUNTRY_OPTIONS.map((country) => (
                    <s-option key={country.value} value={country.value}>
                      {country.label}
                    </s-option>
                  ))}
                </s-select>

                <s-text-field
                  name="addressLine1"
                  label="Address"
                  placeholder="Enter address"
                  defaultValue={values.addressLine1}
                />

                <s-text-field
                  name="addressLine2"
                  label="Apartment, suite, etc (Optional)"
                  placeholder="Enter apartment, suite, etc"
                  defaultValue={values.addressLine2}
                />

                <s-text-field
                  name="city"
                  label="City"
                  placeholder="Enter city"
                  defaultValue={values.city}
                />

                <s-text-field
                  name="region"
                  label="State / region"
                  placeholder="Enter state or region"
                  defaultValue={values.region}
                />

                <s-text-field
                  name="postalCode"
                  label="Pincode"
                  placeholder="Enter pincode"
                  defaultValue={values.postalCode}
                />

              </s-stack>
            </s-section>

            <s-section heading="Enter the email address to receive booking notifications.">
              <s-text-field
                name="bookingNotificationEmails"
                label="Booking notification emails"
                labelAccessibilityVisibility="exclusive"
                placeholder="Enter email ID"
                details="If you want to send booking notifications to two or more emails, enter emails separated by a comma."
                defaultValue={values.bookingNotificationEmails}
              />
            </s-section>
          </s-stack>

          <s-stack direction="block" gap="large-300">
            <s-section>
              <s-select name="status" label="Status" value={values.status}>
                <s-option value="enabled">Enabled</s-option>
                <s-option value="disabled">Disabled</s-option>
              </s-select>
            </s-section>
          </s-stack>
        </s-grid>
      </s-page>
    </Form>
  );
}
