import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useEffect, useMemo, useState } from "react";
import {
  Form,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { SaveBar } from "@shopify/app-bridge-react";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import {
  COUNTRY_OPTIONS,
  locationToFormValues,
  nullable,
  readLocationFormValues,
  type LocationFormValues,
} from "../lib/location-form";

type ActionData = {
  error?: string;
  ok?: boolean;
  values?: LocationFormValues;
};

export const loader = async ({ request, params }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const location = await db.location.findFirst({
    where: { id: String(params.id), shop: session.shop },
  });
  if (!location) throw new Response("Not found", { status: 404 });
  return { location };
};

export const action = async ({ request, params }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const intent = String(form.get("intent"));

  if (intent === "delete") {
    // Guard: never delete a location that events still reference.
    const inUse = await db.classProduct.count({
      where: { shop: session.shop, locationId: String(params.id) },
    });
    if (inUse > 0) {
      return {
        error: `Can't delete: ${inUse} event${inUse === 1 ? "" : "s"} still use this location. Reassign or remove them first.`,
      };
    }
    const deleted = await db.location.deleteMany({
      where: { id: String(params.id), shop: session.shop },
    });
    if (deleted.count === 0) throw new Response("Not found", { status: 404 });
    return redirect("/app/locations");
  }

  if (intent === "duplicate") {
    const source = await db.location.findFirst({
      where: { id: String(params.id), shop: session.shop },
    });
    if (!source) throw new Response("Not found", { status: 404 });

    const duplicate = await db.location.create({
      data: {
        shop: session.shop,
        name: `${source.name} copy`,
        addressLine1: source.addressLine1,
        addressLine2: source.addressLine2,
        city: source.city,
        region: source.region,
        postalCode: source.postalCode,
        country: source.country,
        timezone: source.timezone,
        archived: source.archived,
      },
    });

    return redirect(`/app/locations/${duplicate.id}`);
  }

  const values = readLocationFormValues(form);

  if (!values.name) return { error: "Location name is required.", values };

  const updated = await db.location.updateMany({
    where: { id: String(params.id), shop: session.shop },
    data: {
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
  if (updated.count === 0) throw new Response("Not found", { status: 404 });
  return { ok: true };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function EditLocation() {
  const { location } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as ActionData | undefined;
  const navigation = useNavigation();
  const persistedValues = useMemo(() => locationToFormValues(location), [location]);
  const [formValues, setFormValues] =
    useState<LocationFormValues>(persistedValues);
  const saving = navigation.state !== "idle";
  const saveBarId = "location-save-bar";
  const saveFormId = "location-details-form";
  const duplicateFormId = "location-duplicate-form";
  const deleteFormId = "location-delete-form";
  const isDirty = JSON.stringify(formValues) !== JSON.stringify(persistedValues);

  useEffect(() => {
    setFormValues(persistedValues);
  }, [persistedValues]);

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
    setFormValues(persistedValues);
  }

  function submitFormById(formId: string) {
    const form = document.getElementById(formId);
    if (form instanceof HTMLFormElement) form.requestSubmit();
  }

  return (
    <s-page heading="Locations">
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

      <s-button
        slot="secondary-actions"
        type="button"
        commandFor="location-actions-menu"
      >
        More actions
      </s-button>

      <s-menu id="location-actions-menu" accessibilityLabel="Location actions">
        <s-button
          icon="duplicate"
          onClick={() => submitFormById(duplicateFormId)}
        >
          Duplicate
        </s-button>
        <s-button
          icon="delete"
          tone="critical"
          commandFor="delete-location-modal"
          command="--show"
        >
          Delete location
        </s-button>
      </s-menu>

      {actionData?.error && (
        <s-banner tone="critical">{actionData.error}</s-banner>
      )}
      {actionData?.ok && <s-banner tone="success">Saved.</s-banner>}

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
            <s-text-field
              name="region"
              label="State"
              placeholder="Enter state"
              value={formValues.region}
              onChange={(e) =>
                setFormValue("region", (e.target as HTMLInputElement).value)
              }
            />

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

      <Form id={duplicateFormId} method="post">
        <input type="hidden" name="intent" value="duplicate" />
      </Form>

      <Form id={deleteFormId} method="post">
        <input type="hidden" name="intent" value="delete" />
      </Form>

      <s-modal id="delete-location-modal" heading="Delete location?">
        <s-stack gap="base">
          <s-text>
            Permanently delete {location.name}? This cannot be undone.
          </s-text>
        </s-stack>
        <s-button
          slot="primary-action"
          variant="primary"
          tone="critical"
          commandFor="delete-location-modal"
          command="--hide"
          onClick={() => submitFormById(deleteFormId)}
        >
          Delete location
        </s-button>
        <s-button
          slot="secondary-actions"
          commandFor="delete-location-modal"
          command="--hide"
        >
          Cancel
        </s-button>
      </s-modal>
    </s-page>
  );
}
