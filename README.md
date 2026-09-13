# DockFlow

DockFlow is a lightweight warehouse receiving and sorting PWA demo. It runs as a static React frontend (React/Babel are loaded from a CDN) with an optional dependency-free Node API. No build step is required.

## Run locally

Requires Node 18+. From this directory:

```bash
npm start
# open http://localhost:3000
```

The browser demo works offline from the UI after the initial CDN load. Use **BOX-1042**, **BOX-1043**, **BOX-1044**, or **BOX-1045** in the receiver. QR payloads in the form `BOXID:BOX-9 SKU:SKU-ALP-01 QTY:10` are also parsed. The camera button is a safe fallback that loads a known demo label; a production scanner can replace that handler with `BarcodeDetector` or `html5-qrcode` without changing routing.

## API

`GET /api/health`, `GET /api/boxes`, and `GET /api/boxes/:boxId` are included. The frontend deliberately defaults to local demo data so it remains usable on a static host.

## PostgreSQL

`db/schema.sql` creates products, capacity locations, boxes, receipts (with duplicate protection), and exceptions. Run schema then seed against a PostgreSQL database:

```bash
psql "$DATABASE_URL" -f db/schema.sql
psql "$DATABASE_URL" -f db/seed.sql
```

## Included flow

Receiving parses BoxID/SKU/quantity, routes the SKU to its capacity location, advances the receiving bar, warns in red on duplicate scans, and resets the success state. Locations, searchable receiving history, and exception resolution are available from the sidebar.
