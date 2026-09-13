# DockFlow

DockFlow is a PostgreSQL-backed warehouse receiving PWA. Sorting uses **exactly 50 permanent physical locations**, numbered 1 through 50. Each warehouse-local day starts with all 50 available; the first new SKU receives the lowest available number, and subsequent cartons for that SKU use the same number until its configured capacity is reached. When all 50 are occupied the API returns exactly `NO AVAILABLE SORTING LOCATION`, records an exception, and never creates location 51.

## Local development

Requires Node 18+, PostgreSQL, and `psql`:

```bash
npm install
export DATABASE_URL='postgres://...'
npm run db:schema
npm run db:seed
npm start
# http://localhost:3000
```

`WAREHOUSE_TIME_ZONE` optionally sets the warehouse IANA timezone (defaults to `America/Chicago`). `DATABASE_URL` is required for data APIs.

## Render + Neon deployment

1. Create a Neon project and copy its pooled connection string.
2. In Render, create a Node web service for this repository with build command `npm install` and start command `npm start`.
3. Set `DATABASE_URL`, `NODE_ENV=production`, and optionally `WAREHOUSE_TIME_ZONE`. Render supplies `PORT`.
4. **Post-merge, run the idempotent schema migration once against Neon** (there is no separate hand-written/manual SQL requirement):

```bash
DATABASE_URL='your-neon-url' npm run db:schema
DATABASE_URL='your-neon-url' npm run db:seed
```

The schema creates and backfills the 1–50 permanent slot table and adds the daily-cycle and assignment tables without deleting historical scans. Seed is safe to repeat. Confirm `/api/health` reports `database: connected`, then open the service and use **Start New Day / Reset** only when a supervisor intentionally closes the current cycle. Automatic rollover creates a new cycle on the next warehouse-local date.

## API

- `GET /api/day` and `POST /api/day/reset`
- `GET /api/locations` (always 50 numbered slots)
- `GET /api/assignments` (today's `LOCATION N -> SKU` assignments)
- `POST /api/scans` with `{boxId, sku, qty, userId, deviceId, inboundId, clientId, boxSequence}`
- `GET /api/boxes`, `GET /api/boxes/:boxId`
- `GET /api/history?q=...`
- `GET /api/archive?from=YYYY-MM-DD&to=YYYY-MM-DD&sku=...&boxId=...&inbound=...&client=...&location=...` (date-grouped archive summaries)
- `GET /api/archive/:date` (expanded day assignments, totals, users/devices, and exceptions)
- `GET /api/archive/export?from=YYYY-MM-DD&to=YYYY-MM-DD` (CSV export; the same filters are supported)
- `GET /api/exceptions` and `POST /api/exceptions/:id/resolve`

Duplicate box scans remain protected by the unique PostgreSQL constraint and transaction lock. Every scan persists warehouse date, SKU, box ID, quantity, numbered location (or an exception), scan time, user, and device. CSV location import is no longer part of normal operation; the numbered physical layout is provisioned by the schema.

## History / Archive

The History tab queries PostgreSQL by warehouse-local date range and renders each active date as an expandable folder. A day includes every assignment's SKU, box, quantity, numbered location, inbound number, client, user, device, and scan time, plus totals and exceptions. Search filters are parameterized and indexed for date, SKU, Box ID, inbound number, client, and location. Export a single day by using the same date for `from` and `to`, or export a range. Starting a new day closes the current cycle only; it never deletes scan, box, assignment, or exception history.

## Tests

```bash
npm test
```
