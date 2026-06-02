import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoute = await readFile(
  new URL("../app/routes/app.tsx", import.meta.url),
  "utf8",
);

test("app nav keeps the Shopify home route hidden and Bookings visible", () => {
  const hiddenHomeLink = appRoute.match(
    /<Link\s+([^>]*\bto="\/app"[^>]*)>\s*Home\s*<\/Link>/s,
  );
  assert.ok(hiddenHomeLink, "expected a hidden Shopify home link for /app");
  assert.match(hiddenHomeLink[1], /\brel="home"/);

  const visibleBookingsLink = appRoute.match(
    /<Link\s+([^>]*\bto="\/app"[^>]*)>\s*Bookings\s*<\/Link>/s,
  );
  assert.ok(visibleBookingsLink, "expected a visible Bookings link for /app");
  assert.doesNotMatch(visibleBookingsLink[1], /\brel="home"/);
});
