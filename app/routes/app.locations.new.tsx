import type { ActionFunctionArgs, HeadersFunction } from "react-router";
import { useEffect, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar } from "@shopify/app-bridge-react";

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
  const saving = navigation.state !== "idle";
  const [formValues, setFormValues] = useState<LocationFormValues>(
    defaultLocationFormValues,
  );
  const isDirty =
    JSON.stringify(formValues) !== JSON.stringify(defaultLocationFormValues);
  const saveBarId = "new-location-save-bar";
  const saveFormId = "new-location-form";

  useEffect(() => {
    if (actionData?.values) setFormValues(actionData.values);
  }, [actionData]);

  function setFormValue<K extends keyof LocationFormValues>(
    key: K,
    value: LocationFormValues[K],
  ) {
    setFormValues((current) => ({ ...current, [key]: value }));
  }

  function submitSaveForm() {
    const form = document.getElementById(saveFormId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  function discardChanges() {
    setFormValues(defaultLocationFormValues);
  }

  return (
    <s-page heading="New Location">
      <s-link slot="breadcrumb-actions" href="/app/locations">
        Locations
      </s-link>

      <SaveBar id={saveBarId} open={isDirty}>
        <button
          type="button"
          disabled={saving}
          onClick={submitSaveForm}
          {...({ variant: "primary" } as Record<string, string>)}
        >
          Save
        </button>
        <button type="button" disabled={saving} onClick={discardChanges}>
          Discard
        </button>
      </SaveBar>

      {actionData?.error && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}

      <Form id={saveFormId} method="post">
        <input type="hidden" name="status" value={formValues.status} />
        <s-section heading="Location details">
          <s-text-field
            name="name"
            label="Location name"
            placeholder="Enter your branch name / location name"
            value={formValues.name}
            onChange={(e) =>
              setFormValue("name", (e.target as HTMLInputElement).value)
            }
          />

          <s-select
            name="country"
            label="Country"
            value={formValues.country}
            onChange={(e) =>
              setFormValue("country", (e.target as HTMLSelectElement).value)
            }
          >
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
            value={formValues.addressLine1}
            onChange={(e) =>
              setFormValue("addressLine1", (e.target as HTMLInputElement).value)
            }
          />

          <s-text-field
            name="addressLine2"
            label="Apartment, suite, etc"
            placeholder="Enter apartment, suite, etc"
            value={formValues.addressLine2}
            onChange={(e) =>
              setFormValue("addressLine2", (e.target as HTMLInputElement).value)
            }
          />

          <s-text-field
            name="city"
            label="City"
            placeholder="Enter city"
            value={formValues.city}
            onChange={(e) =>
              setFormValue("city", (e.target as HTMLInputElement).value)
            }
          />

          <s-grid gridTemplateColumns="1fr 1fr" gap="base">
            <s-select
              name="region"
              label="State"
              value={formValues.region}
              onChange={(e) =>
                setFormValue("region", (e.target as HTMLSelectElement).value)
              }
            >
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
              value={formValues.postalCode}
              onChange={(e) =>
                setFormValue("postalCode", (e.target as HTMLInputElement).value)
              }
            />
          </s-grid>
        </s-section>
      </Form>

      <s-section slot="aside" heading="Status">
        <s-select
          label="Status"
          labelAccessibilityVisibility="exclusive"
          value={formValues.status}
          onChange={(e) =>
            setFormValue(
              "status",
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
