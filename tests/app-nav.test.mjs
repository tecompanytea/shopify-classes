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
const embeddedAdminUrl = await readFile(
  new URL("../app/lib/embedded-admin-url.ts", import.meta.url),
  "utf8",
);

test("app nav keeps /app as the hidden Shopify home route", () => {
  const hiddenHomeLink = appRoute.match(
    /<Link\s+([^>]*\bto=\{homeHref\}[^>]*)>\s*Home\s*<\/Link>/s,
  );
  assert.ok(hiddenHomeLink, "expected a hidden Shopify home link for /app");
  assert.match(hiddenHomeLink[1], /\brel="home"/);
  assert.match(appRoute, /embeddedAppPath\(\s*"\/app",\s*session\.shop/s);

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
  assert.match(publicRootRoute, /url\.searchParams\.get\("appLoadId"\)/);
  assert.match(publicRootRoute, /shopFromAdminReferer\(request\.headers\.get\("referer"\)\)/);
  assert.match(publicRootRoute, /configuredShop\(\)/);
  assert.match(publicRootRoute, /findInstalledShop\(\)/);
  assert.match(publicRootRoute, /redirect\(embeddedAppPath\("\/app", shop\)\)/);
  assert.doesNotMatch(
    publicRootRoute,
    /Boolean\(url\.searchParams\.get\("appLoadId"\)\)/,
    "appLoadId alone is not enough context for authenticate.admin",
  );
});

test("embedded app paths include the Shopify auth context required for document requests", () => {
  assert.match(embeddedAdminUrl, /shopifyAdminHostParam/);
  assert.match(embeddedAdminUrl, /admin\.shopify\.com\/store\/\$\{storeHandle\}/);
  assert.match(embeddedAdminUrl, /params\.set\("shop", shop\)/);
  assert.match(embeddedAdminUrl, /params\.set\("host", hostParam/);
  assert.match(embeddedAdminUrl, /params\.set\("embedded", "1"\)/);
  assert.match(embeddedAdminUrl, /shopFromAdminReferer/);
  assert.match(embeddedAdminUrl, /chooseInstalledShop/);
  assert.match(embeddedAdminUrl, /!shop\.toLowerCase\(\)\.includes\("dev"\)/);
});
