import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appRoute = await readFile(
  new URL("../app/routes/app.tsx", import.meta.url),
  "utf8",
);
const homeRoute = await readFile(
  new URL("../app/routes/app._index.tsx", import.meta.url),
  "utf8",
);
const publicRootRoute = await readFile(
  new URL("../app/routes/_index/route.tsx", import.meta.url),
  "utf8",
);

test("app nav keeps /app as the hidden Shopify home route", () => {
  const hiddenHomeLink = appRoute.match(
    /<Link\s+([^>]*\bto="\/app"[^>]*)>\s*Home\s*<\/Link>/s,
  );
  assert.ok(hiddenHomeLink, "expected a hidden Shopify home link for /app");
  assert.match(hiddenHomeLink[1], /\brel="home"/);

  assert.doesNotMatch(
    appRoute,
    /<Link\s+[^>]*\bto="\/app"[^>]*>\s*Bookings\s*<\/Link>/s,
    "Bookings should not be a visible app nav item",
  );

  const visibleEventsLink = appRoute.match(
    /<Link\s+([^>]*\bto="\/app\/classes"[^>]*)>\s*Events\s*<\/Link>/s,
  );
  assert.ok(visibleEventsLink, "expected a visible Events link");
  assert.doesNotMatch(visibleEventsLink[1], /\brel="home"/);
});

test("app home uses the app label instead of Bookings", () => {
  assert.match(homeRoute, /<s-page heading="Classes">/);
  assert.doesNotMatch(homeRoute, /<s-page heading="Bookings">/);
});

test("Shopify app home clicks with appLoadId redirect into the embedded app", () => {
  assert.match(publicRootRoute, /searchParams\.get\("appLoadId"\)/);
  assert.match(publicRootRoute, /redirect\(`\/app\?\$\{url\.searchParams\.toString\(\)\}`\)/);
});
