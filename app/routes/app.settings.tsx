import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import {
  Form,
  useActionData,
  useLoaderData,
  useRouteError,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";
import db from "../db.server";
import { CLASS_TIMEZONE, DEFAULT_CLASS_START_TIME } from "../lib/class-config";
import { getOrCreateShopSettings } from "../lib/settings.server";
import {
  normalizeSessionTime,
  SESSION_TIME_OPTIONS,
} from "../lib/session-time-options";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const [settings, locations] = await Promise.all([
    getOrCreateShopSettings(session.shop),
    db.location.findMany({
      where: { shop: session.shop, archived: false },
      orderBy: { name: "asc" },
    }),
  ]);
  return { settings, locations };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const form = await request.formData();
  const settings = await getOrCreateShopSettings(session.shop);

  await db.shopSettings.update({
    where: { id: settings.id },
    data: {
      defaultTimezone: CLASS_TIMEZONE,
      defaultStartTime: normalizeSessionTime(
        form.get("defaultStartTime"),
        settings.defaultStartTime ?? DEFAULT_CLASS_START_TIME,
      ),
      defaultCapacity: Number(
        form.get("defaultCapacity") ?? settings.defaultCapacity,
      ),
      defaultLocationId: String(form.get("defaultLocationId") ?? "") || null,
    },
  });
  return { ok: true };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Settings() {
  const { settings, locations } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>() as { ok?: boolean } | undefined;

  return (
    <s-page heading="Settings">
      <s-section heading="Defaults for new events">
        {actionData?.ok && <s-banner tone="success">Saved.</s-banner>}
        <Form method="post">
          <s-stack direction="block" gap="base">
            <s-select
              name="defaultStartTime"
              label="Default start time"
              icon="clock"
              value={settings.defaultStartTime ?? DEFAULT_CLASS_START_TIME}
            >
              {SESSION_TIME_OPTIONS.map((option) => (
                <s-option key={option.value} value={option.value}>
                  {option.label}
                </s-option>
              ))}
            </s-select>
            <s-number-field
              name="defaultCapacity"
              label="Default capacity (seats)"
              defaultValue={String(settings.defaultCapacity)}
            />
            <s-select
              name="defaultLocationId"
              label="Default display location"
              value={settings.defaultLocationId ?? ""}
            >
              <s-option value="">None</s-option>
              {locations.map((l) => (
                <s-option key={l.id} value={l.id}>
                  {l.name}
                </s-option>
              ))}
            </s-select>
            <s-button type="submit" variant="primary">
              Save
            </s-button>
          </s-stack>
        </Form>
      </s-section>
    </s-page>
  );
}
