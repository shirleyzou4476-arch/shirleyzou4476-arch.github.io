# DockFlow

DockFlow is a production warehouse receiving PWA. The Node server serves the React UI and same-origin API; **production data is stored in PostgreSQL (Neon recommended), not browser or in-memory demo state**.

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

`PORT` defaults to `3000`. `DATABASE_URL` is required for all data APIs; `/api/health` remains available without it and reports database status.

## Render + Neon deployment

1. Create a Neon project and copy its pooled connection string. It must include the password and SSL is enabled automatically in production.
2. In Render, create **New → Web Service**, connect this repository, choose Node 18+, and set the build command to `npm install` and the start command to `npm start`.
3. Add the environment variables `DATABASE_URL` (the Neon connection string), `NODE_ENV=production`, and optionally `PORT` (Render supplies `PORT` automatically; do not hard-code it).
4. Deploy once, then run the schema and idempotent seed from a machine with `psql`:

```bash
DATABASE_URL='your-neon-url' npm run db:schema
DATABASE_URL='your-neon-url' npm run db:seed
```

Alternatively run those two commands from Render's shell. Confirm `https://your-service.onrender.com/api/health` reports `database: connected`.

## API

- `GET /api/health`
- `GET /api/boxes` and `/api/boxes/:boxId`
- `POST /api/scans` with `{boxId, sku, qty, userId, deviceId, inboundId, clientId, boxSequence}`
- `GET /api/locations`
- `POST /api/locations/import` with `{replace, locations: [{location, SKU, capacity}]}`
- `GET /api/history?q=BOX-...`
- `GET /api/exceptions`
- `POST /api/exceptions/:id/resolve`

PostgreSQL's unique `scan_events(box_id)` constraint and the transactional row lock make duplicate scans return `409` safely under concurrency. `db/seed.sql` uses conflict-safe upserts and can be run repeatedly.

The Locations page accepts a CSV with the exact header `location,SKU,capacity`. Imports are validated for required fields, positive whole-number capacity, duplicate location codes, and known products before PostgreSQL is changed. Selecting **Replace current locations** atomically replaces locations and rebuilds SKU routing priorities; clearing it adds routes to the existing configuration. Use **Download template** in the import dialog for a starter CSV. A failed import returns `422` with row-level errors and does not partially save.

## Tests

```bash
npm test
```
