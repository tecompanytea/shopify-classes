import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData, useNavigate, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

import { authenticate } from "../shopify.server";

type RangePreset =
  | "last-7-days"
  | "last-14-days"
  | "next-7-days"
  | "next-14-days"
  | "next-30-days";

const RANGE_OPTIONS: { label: string; preset: RangePreset }[] = [
  { label: "Last 7 days", preset: "last-7-days" },
  { label: "Last 14 days", preset: "last-14-days" },
  { label: "Next 7 days", preset: "next-7-days" },
  { label: "Next 14 days", preset: "next-14-days" },
  { label: "Next 30 days", preset: "next-30-days" },
];

const DEFAULT_PRESET: RangePreset = "last-7-days";

type DashboardLoader = {
  preset: RangePreset;
};

export const loader = async ({ request }: LoaderFunctionArgs): Promise<DashboardLoader> => {
  await authenticate.admin(request);
  const url = new URL(request.url);
  const preset = parseRangePreset(url.searchParams.get("range")) ?? DEFAULT_PRESET;
  return { preset };
};

export const headers: HeadersFunction = (headersArgs) =>
  boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export default function Dashboard() {
  const { preset } = useLoaderData<typeof loader>();
  const navigate = useNavigate();
  const activeLabel = RANGE_OPTIONS.find((o) => o.preset === preset)!.label;

  return (
    <s-page heading="Summary">
      <s-button
        variant="secondary"
        icon="calendar"
        accessibilityLabel="Select date range"
        commandFor="summary-range-popover"
      >
        {activeLabel}
      </s-button>
      <s-popover id="summary-range-popover">
        <s-box paddingBlock="small-200" paddingInline="base">
          <s-choice-list
            label="Select date range"
            name="summary-range"
            labelAccessibilityVisibility="exclusive"
            values={[preset]}
            onChange={(event) => {
              const next = event.currentTarget.values[0];
              if (next && next !== preset) navigate(`/app?range=${next}`);
            }}
          >
            {RANGE_OPTIONS.map((option) => (
              <s-choice key={option.preset} value={option.preset}>
                {option.label}
              </s-choice>
            ))}
          </s-choice-list>
        </s-box>
      </s-popover>
    </s-page>
  );
}

function parseRangePreset(value: string | null): RangePreset | null {
  return RANGE_OPTIONS.find((option) => option.preset === value)?.preset ?? null;
}
