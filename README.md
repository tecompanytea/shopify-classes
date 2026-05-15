# shopify-classes

Embedded Shopify admin app for TE Company that turns Shopify products into bookable classes and their variants into dated/timed sessions.

## Core principle

Shopify is the source of truth. The app stores configuration and schedule rules only.

| Concept              | Shopify entity                                |
| -------------------- | --------------------------------------------- |
| Class                | Product                                       |
| Session / class date | Product variant                               |
| Seats available      | Variant inventory                             |
| Booking              | Order line item referencing a class variant   |

This app does **not** implement a separate checkout, calendar, or seat ledger.

## Stack

- React Router v7 (Vite, file-route convention)
- Polaris (App Bridge web components) + `@shopify/shopify-app-react-router`
- Prisma + Postgres for session storage and class configuration
- Shopify Admin GraphQL (October 2025 API)
- Deployed on Vercel via `@vercel/react-router`

See `tecompanytea/shopify-corporate-addresses` (skeleton ref) and `tecompanytea/shopify-subscriptions` (services/extensions ref).

## Local setup

```bash
cp .env.example .env       # fill in DATABASE_URL + DATABASE_URL_UNPOOLED
npm install
npm run setup              # prisma generate + db push
npm run dev                # shopify app dev
```

## Scripts

- `npm run dev` — Shopify CLI tunnel + Vite
- `npm run build` — React Router production build
- `npm run setup` — `prisma generate && prisma db push`
- `npm run typecheck` — RR typegen + `tsc --noEmit`
- `npm run lint` — eslint
- `npm run deploy` — `shopify app deploy`

## Routes

- `/` — public landing
- `/auth/*` — OAuth + login
- `/app` — embedded shell (Polaris, App Bridge, NavMenu)
- `/app` — class list (index)
- `/app/classes/new` — step-by-step class wizard
- `/app/classes/:id` — class detail (sessions, capacity, config)
- `/app/locations` — locations list/create
- `/app/bookings` — bookings list (orders containing class line items)
- `/app/settings` — defaults (timezone, duration, capacity, location)
- `/webhooks/*` — Shopify webhook receivers
