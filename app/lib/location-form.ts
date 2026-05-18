import { CLASS_TIMEZONE } from "./class-config";

export type LocationStatus = "enabled" | "disabled";

export type LocationFormValues = {
  name: string;
  country: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  timezone: string;
  status: LocationStatus;
};

export type PersistedLocationFormValues = {
  name: string;
  country: string | null;
  addressLine1: string | null;
  addressLine2: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
  timezone: string;
  archived: boolean;
};

export const defaultLocationFormValues: LocationFormValues = {
  name: "",
  country: "",
  addressLine1: "",
  addressLine2: "",
  city: "",
  region: "",
  postalCode: "",
  timezone: CLASS_TIMEZONE,
  status: "enabled",
};

export const COUNTRY_OPTIONS = [
  { value: "", label: "Select country" },
  { value: "United States", label: "United States" },
  { value: "Canada", label: "Canada" },
  { value: "United Kingdom", label: "United Kingdom" },
  { value: "Australia", label: "Australia" },
  { value: "France", label: "France" },
  { value: "Germany", label: "Germany" },
  { value: "Hong Kong", label: "Hong Kong" },
  { value: "Japan", label: "Japan" },
  { value: "Singapore", label: "Singapore" },
];

export function readLocationFormValues(form: FormData): LocationFormValues {
  const status = String(form.get("status") ?? "enabled");

  return {
    name: field(form, "name"),
    country: field(form, "country"),
    addressLine1: field(form, "addressLine1"),
    addressLine2: field(form, "addressLine2"),
    city: field(form, "city"),
    region: field(form, "region"),
    postalCode: field(form, "postalCode"),
    timezone: CLASS_TIMEZONE,
    status: status === "disabled" ? "disabled" : "enabled",
  };
}

export function locationToFormValues(
  location: PersistedLocationFormValues,
): LocationFormValues {
  return {
    name: location.name,
    country: location.country ?? "",
    addressLine1: location.addressLine1 ?? "",
    addressLine2: location.addressLine2 ?? "",
    city: location.city ?? "",
    region: location.region ?? "",
    postalCode: location.postalCode ?? "",
    timezone: CLASS_TIMEZONE,
    status: location.archived ? "disabled" : "enabled",
  };
}

export function nullable(value: string): string | null {
  return value ? value : null;
}

function field(form: FormData, name: keyof LocationFormValues): string {
  return String(form.get(name) ?? "").trim();
}
