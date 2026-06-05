export const SESSION_TIME_OPTIONS = Array.from({ length: 27 }, (_, index) => {
  const totalMinutes = 8 * 60 + index * 30;
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  const value = `${String(hour).padStart(2, "0")}:${String(minute).padStart(
    2,
    "0",
  )}`;
  const labelHour = hour % 12 || 12;
  const meridiem = hour < 12 ? "AM" : "PM";

  return {
    value,
    label: `${labelHour}:${String(minute).padStart(2, "0")} ${meridiem}`,
  };
});

export function normalizeSessionTime(
  value: FormDataEntryValue | string | null | undefined,
  fallback: string,
) {
  const candidate = String(value ?? "");
  return SESSION_TIME_OPTIONS.some((option) => option.value === candidate)
    ? candidate
    : fallback;
}

export function sessionTimeLabel(value: string) {
  return (
    SESSION_TIME_OPTIONS.find((option) => option.value === value)?.label ??
    value
  );
}
