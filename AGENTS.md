# AGENTS.md — shopify-classes

Operating guide for any AI agent (Claude Code, Cursor, Copilot, etc.) contributing to this repository. The rules in this file are not preferences — they are required.

This app is a Shopify embedded admin app built with React Router v7 + Prisma. **All UI is built with Shopify admin web components (`s-*` tags) from `@shopify/polaris-types`.** No Polaris React, no raw HTML for layout, no custom CSS unless you genuinely can't compose the result from these primitives.

---

## Cardinal rules

1. **Never reuse old code.** Do not pull patterns from git history, removed code in diffs, or prior commits. Treat every implementation as a fresh write against the current docs and current repo state. Old code in this repo has known drift the user does not want propagated.

2. **Read the docs before writing `s-*` markup.** Authoritative source is `https://shopify.dev/docs/api/admin-extensions/latest/web-components/<category>/<component>`. Fetch the relevant page(s) before writing the JSX. If you are using a component for the first time in a session, you have not read its docs yet — fetch them.

3. **Implement exactly what was asked. No bonus affordances.** No icons the user didn't ask for. No labels the user didn't ask for. No checkmarks. No tooltips. No "while I'm here" cleanup. If the user wants three buttons, ship three buttons.

4. **Verify, don't guess.** If unsure whether an attribute exists, whether a child element is valid, or what a default value is, look it up. Do not infer from other components or from training data.

5. **Match the doc's example structure exactly.** If the doc shows trigger + menu as siblings, do not wrap them in a container. If the doc says a child must be `s-button` or `s-section`, do not put anything else there.

---

## Verified component reference

The facts below come from the official component docs (admin-extensions `2026-01`) and the project's installed `@shopify/polaris-types`. Re-verify against the live docs before relying on these — types and docs can drift between versions.

### `s-page` (route root)

Lives in: app-home polaris-web-components (`/structure/page`), not admin-extensions.

- **Required:** `heading` (string).
- **Attributes:** `inlineSize="small" | "base" | "large"` (default `"base"`).
- **Slots:** `breadcrumb-actions` (links only), `primary-action` (one button, max), `secondary-actions` (button group, max 3), default children (main content), `aside` (only renders when `inlineSize="base"`).
- Use as the **root** of every authenticated app route.

### `s-section`

- **Required:** `heading` (string), `accessibilityLabel` (string).
- **Attributes:** `padding="base" | "none"` (default `"base"`).
- Limit nesting to **2–3 levels**.

### `s-stack`

- **Attributes:** `direction="block" | "inline"` (default `"block"`), `gap` (spacing keyword: `none`, `small-100`, `small`, `base`, `large-100`, `large`, etc.), `alignItems`, `justifyContent`, `padding`.
- Gaps are uniform across children — no per-item spacing.

### `s-grid`

- **Attributes:** `gridTemplateColumns` (CSS grid-template-columns syntax: `"1fr auto"`, `"repeat(2, 1fr)"`), `gridTemplateRows`, `gap`, `justifyItems`, `alignItems`, `padding`, `border`.
- Children should be `s-grid-item` when spanning is needed; otherwise any element.
- No CSS subgrid.

### `s-box`

- **Attributes:** `padding`, `background="transparent" | "subdued" | "base" | "strong"`, `borderRadius`, `borderColor`, `border`, `accessibilityRole`.
- Low-level primitive. **Prefer `s-stack` / `s-grid` for layout.** Do not wrap menu triggers in `s-box`.

### `s-button`

- **Attributes:**
  - `variant="auto" | "primary" | "secondary" | "tertiary"` (default `"auto"`). Primary should be used sparingly — one per page area.
  - `tone="auto" | "neutral" | "critical"` (default `"auto"`).
  - `icon` — string from the icon catalog (see "Icons" below). Do **not** wrap an `<s-icon>` inside an `<s-button>`; pass the icon as a string attribute.
  - `accessibilityLabel` — required for icon-only buttons.
  - `disabled`, `loading` (booleans). Prefer `loading` over `disabled` for async actions.
  - `href`, `target`, `download` — for link-style buttons.
  - `type="button" | "submit"` (default `"button"`).
  - `commandFor` — id of a component to control (e.g. an `s-menu`).
  - `command="--auto" | "--show" | "--hide" | "--toggle"` (default `"--auto"` — toggles by default; do **not** add `command="--toggle"` redundantly).
- If both `href` and `commandFor` are set, the **command runs** instead of navigation.

### `s-menu`

- **Required:** `accessibilityLabel` (string).
- **Anchoring:** trigger button's `commandFor` must equal the menu's `id`. **Menu must be a sibling of the trigger** — do not wrap them together in a layout container with its own stacking context; the menu can clip or position incorrectly.
- **Valid children:** `s-button` (for actions) and `s-section` (for grouped items with optional `heading`). Nothing else — no `s-divider`, no raw HTML.
- Menu items use `href=` for navigation or `onClick=` for handlers. Item buttons may carry `icon=` and `tone="critical"` for destructive actions.
- Keep menu length to ~10–12 items. Beyond that, choose a different pattern.
- **When to use `s-menu` vs `s-popover`:** `s-menu` is for a list of actions (each is a button). For **selection state** (radios/checkboxes), filters, or arbitrary content in a popover panel, use `s-popover` containing an `s-choice-list` (see below).

### `s-popover`

- General-purpose overlay container. Same `commandFor` ↔ `id` trigger mechanism as `s-menu`.
- **Children:** any HTML / Shopify components — unlike `s-menu`, you can put `s-choice-list`, `s-text-field`, etc. inside.
- **Attributes:** `inlineSize`, `blockSize`, `minInlineSize`, `maxInlineSize`, `minBlockSize`, `maxBlockSize` (all accept px / % / `auto` / `none`).
- **Events:** `show` / `aftershow` / `hide` / `afterhide` / `toggle` / `aftertoggle`.
- **Limitations:** can only open via user interaction (no programmatic auto-open on page load); position is anchored to the trigger and can't be overridden.
- **Common composition:** `s-popover > s-box[padding="base"] > s-choice-list` — see the date-range picker in `app/routes/app._index.tsx` for the canonical example in this repo.

### `s-choice-list` / `s-choice`

- **Use case:** radio (single) or checkbox (multiple) selection group. Often placed inside an `s-popover` for filter-style UIs.
- **`s-choice-list` attributes:**
  - `label` (string, required), `labelAccessibilityVisibility="visible" | "exclusive"` (use `"exclusive"` to hide the label visually but keep it for screen readers).
  - `name` (string, required) — form identifier.
  - `multiple` (bool, default `false`) — `true` for checkbox semantics.
  - `values` (string[]) — controlled selection. For uncontrolled, set `defaultSelected` on individual `s-choice`s.
  - `disabled`, `error`, `details`.
- **`s-choice` attributes:** `value` (string, required), `selected` / `defaultSelected`, `disabled`, `accessibilityLabel`. Children = label text.
- **Selection event:** `onChange` fires with the event; read selected values from `event.currentTarget.values` (always a `string[]`, even in single-select mode).
- **Limit to ~20 options.** Beyond that, use `s-select`.

### `s-icon`

- **Required-ish:** `type` — icon name from the catalog. `type=""` hides; `type="empty"` reserves space.
- **Attributes:** `size="small" | "base"`, `tone="auto" | "info" | "success" | "warning" | "critical" | "neutral" | "caution"`, `color="base" | "subdued"`, `interestFor` (for tooltips).
- Standalone usage. Inside other components (like `s-button`), use the `icon=` attribute instead — do **not** nest `<s-icon>` as a child.

### Icons (catalog)

- Icon names are **kebab-case, lowercase** (e.g. `calendar`, `chevron-down`, `menu-horizontal`). Not `CalendarIcon`, not `calendar-icon`.
- The canonical list lives in `node_modules/@shopify/polaris-types/dist/polaris.d.ts` as the `IconType` union. Grep that file when you need to verify a name.
- Examples confirmed valid: `calendar`, `calendar-check`, `calendar-time`, `plus`, `duplicate`, `archive`, `edit`, `delete`, `view`, `menu-horizontal`, `check`.
- **`icon="empty"`** reserves the icon slot without rendering a visible icon — use it on sibling items in a menu/list when only some items have a real icon, so labels stay aligned. The `empty` value is in the icon `IconType` union and is the documented way to reserve space on `s-icon` (`type="empty"`).

### Feedback / status

- `s-banner` for prominent messages. Use `tone="critical"` for errors.
- `s-badge` for inline status (e.g. order state).
- `s-spinner` for inline loading. For data fetches, prefer `s-query-container`.

### Forms

- Field components: `s-text-field`, `s-email-field`, `s-number-field`, `s-money-field`, `s-password-field`, `s-search-field`, `s-url-field`, `s-text-area`, `s-select`, `s-checkbox`, `s-choice-list`, `s-switch`, `s-date-field`, `s-date-picker`, `s-color-field`, `s-color-picker`, `s-drop-zone`.
- Wrap in `s-form` for implicit submit on Enter.

---

## Required workflow for any UI task

1. **Restate the ask.** One sentence. If the ask is ambiguous, ask the user a clarifying question before writing code.
2. **Identify components.** Decide which `s-*` components are involved. Do not pick a Polaris React component, raw `<div>`, or custom CSS.
3. **Read the docs.** Fetch each component's doc page from `shopify.dev/docs/api/admin-extensions/latest/web-components/<category>/<component>`. Quote attribute names and example structure verbatim into your working notes.
4. **Cross-check the type union** in `node_modules/@shopify/polaris-types/dist/polaris.d.ts` for anything ambiguous (icon names, variant values, tone values).
5. **Write the minimum markup.** Match the doc's example structure. Do not wrap, decorate, or extend beyond the ask.
6. **Stop.** Do not add follow-on features the user did not request.

---

## Anti-patterns observed in this project

These are real mistakes that have happened. Do not repeat them.

- Reaching for `<s-menu>` when the right primitive is `<s-popover>`. `s-menu` only accepts `s-button` / `s-section` children — if you need a choice list, form fields, or anything else inside the dropdown, use `s-popover`.
- Wrapping `<s-button>` trigger + `<s-menu>` in `<s-box>`. The box breaks anchoring / introduces a stacking context. Triggers must be **siblings** of their menus.
- Adding `command="--toggle"` to a menu trigger. The default `--auto` already toggles.
- Putting a checkmark `icon=` on menu items to indicate the active option. The docs do not prescribe this pattern. Don't add it unless the user asks.
- Putting a computed date label on a menu trigger when the user only asked for a preset name.
- Copy-pasting a previous version of a file from `git show` instead of writing fresh.
- Adding `<s-icon>` as a child of `<s-button>`. Use the `icon=` attribute on the button.

---

## When you must deviate

If the docs genuinely don't cover what the user is asking for, **say so** and propose options. Do not invent attributes. Do not guess at undocumented behavior. Do not silently fall back to a different pattern.

---

## Related files

- `CLAUDE.md` — Claude Code project context (if present).
- `.claude/projects/.../memory/MEMORY.md` — agent memory index (Claude Code only).
