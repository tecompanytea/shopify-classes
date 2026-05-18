import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useState } from "react";
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
  nullable,
  readLocationFormValues,
  type LocationFormValues,
} from "../lib/location-form";

const STATE_OPTIONS = [
  { value: "", label: "Select state" },
  { value: "Alabama", label: "Alabama" },
  { value: "Alaska", label: "Alaska" },
  { value: "Arizona", label: "Arizona" },
  { value: "Arkansas", label: "Arkansas" },
  { value: "California", label: "California" },
  { value: "Colorado", label: "Colorado" },
  { value: "Connecticut", label: "Connecticut" },
  { value: "Delaware", label: "Delaware" },
  { value: "District of Columbia", label: "District of Columbia" },
  { value: "Florida", label: "Florida" },
  { value: "Georgia", label: "Georgia" },
  { value: "Hawaii", label: "Hawaii" },
  { value: "Idaho", label: "Idaho" },
  { value: "Illinois", label: "Illinois" },
  { value: "Indiana", label: "Indiana" },
  { value: "Iowa", label: "Iowa" },
  { value: "Kansas", label: "Kansas" },
  { value: "Kentucky", label: "Kentucky" },
  { value: "Louisiana", label: "Louisiana" },
  { value: "Maine", label: "Maine" },
  { value: "Maryland", label: "Maryland" },
  { value: "Massachusetts", label: "Massachusetts" },
  { value: "Michigan", label: "Michigan" },
  { value: "Minnesota", label: "Minnesota" },
  { value: "Mississippi", label: "Mississippi" },
  { value: "Missouri", label: "Missouri" },
  { value: "Montana", label: "Montana" },
  { value: "Nebraska", label: "Nebraska" },
  { value: "Nevada", label: "Nevada" },
  { value: "New Hampshire", label: "New Hampshire" },
  { value: "New Jersey", label: "New Jersey" },
  { value: "New Mexico", label: "New Mexico" },
  { value: "New York", label: "New York" },
  { value: "North Carolina", label: "North Carolina" },
  { value: "North Dakota", label: "North Dakota" },
  { value: "Ohio", label: "Ohio" },
  { value: "Oklahoma", label: "Oklahoma" },
  { value: "Oregon", label: "Oregon" },
  { value: "Pennsylvania", label: "Pennsylvania" },
  { value: "Rhode Island", label: "Rhode Island" },
  { value: "South Carolina", label: "South Carolina" },
  { value: "South Dakota", label: "South Dakota" },
  { value: "Tennessee", label: "Tennessee" },
  { value: "Texas", label: "Texas" },
  { value: "Utah", label: "Utah" },
  { value: "Vermont", label: "Vermont" },
  { value: "Virginia", label: "Virginia" },
  { value: "Washington", label: "Washington" },
  { value: "West Virginia", label: "West Virginia" },
  { value: "Wisconsin", label: "Wisconsin" },
  { value: "Wyoming", label: "Wyoming" },
];

type ActionData = {
  error?: string;
  values?: LocationFormValues;
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const values = readLocationFormValues(form);

  if (!values.name) return { error: "Location name is required.", values };

  await db.location.create({
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
      archived: values.status === "disabled",
    },
  });
  return redirect("/app/locations");
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
  const saveFormId = "new-location-form";
  const [status, setStatus] = useState(values.status);

  function submitSaveForm() {
    const form = document.getElementById(saveFormId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  return (
    <s-page heading="New Location" back-href="/app/locations">
      <s-button
        slot="primary-action"
        type="button"
        loading={saving ? true : undefined}
        onClick={submitSaveForm}
      >
        Save
      </s-button>

      {actionData?.error && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <Form id={saveFormId} method="post">
        <input type="hidden" name="status" value={status} />
        <s-section heading="Location details">
          <s-text-field
            name="name"
            label="Location name"
            placeholder="Enter your branch name / location name"
            defaultValue={values.name}
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
            label="Apartment, suite, etc"
            placeholder="Enter apartment, suite, etc"
            defaultValue={values.addressLine2}
          />

          <s-text-field
            name="city"
            label="City"
            placeholder="Enter city"
            defaultValue={values.city}
          />

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select name="region" label="State" value={values.region}>
              {STATE_OPTIONS.map((state) => (
                <s-option key={state.value} value={state.value}>
                  {state.label}
                </s-option>
              ))}
            </s-select>

            <s-text-field
              name="postalCode"
              label="Zip code"
              placeholder="Enter zip code"
              defaultValue={values.postalCode}
            />
          </s-grid>
        </s-section>
      </Form>

      <s-section slot="aside" heading="Status">
        <s-select
          label="Status"
          value={status}
          onChange={(e) =>
            setStatus(
              (e.target as HTMLSelectElement).value === "disabled"
                ? "disabled"
                : "enabled",
            )
          }
        >
          <s-option value="enabled">Enabled</s-option>
          <s-option value="disabled">Disabled</s-option>
        </s-select>
      </s-section>
    </s-page>
  );
}
