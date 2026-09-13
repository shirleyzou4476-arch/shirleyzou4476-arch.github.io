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

### Android warehouse PDA

DockFlow is installable as a PWA over HTTPS (or `localhost` during development). On
an Android PDA, open the service URL in Chrome, choose **Install app** / **Add to
Home screen**, then open **PDA Scan**. Allow camera access to scan QR labels with
the rear camera. If the camera is unavailable or permission is declined, enter a
Box ID or the complete QR payload in the large manual field; it uses the same
`POST /api/scans` path and therefore keeps duplicate, capacity, and exception
semantics unchanged. The service worker caches only the application shell and
never caches `/api/*` responses, so operational data remains live.

The production warehouse timezone is fixed to **America/Chicago** in the API. It is never taken from the server timezone, UTC, or an environment override; the JavaScript `Intl` timezone database applies DST transitions automatically. `DATABASE_URL` is required for data APIs.

## Render + Neon deployment

1. Create a Neon project and copy its pooled connection string.
2. In Render, create a Node web service for this repository with build command `npm install` and start command `npm start`.
3. Set these Render environment variables: `DATABASE_URL` (Neon pooled URL), `NODE_ENV=production`, and let Render provide `PORT`. Do not add frontend secrets.
4. **After the PR is merged, redeploy Render and run the idempotent schema migration once against Neon** (there is no separate hand-written/manual SQL requirement):

```bash
DATABASE_URL='your-neon-url' npm run db:schema
DATABASE_URL='your-neon-url' npm run db:seed
```

5. Confirm `/api/health` reports `database: connected`, then open the service. If the current cycle must be restarted on the same local date, an administrator uses **Start New Day / Reset** and confirms the screen. Automatic rollover creates a new cycle on the next America/Chicago date. The migration adds cycle provenance (`started_by`, `start_mode`) and never deletes historical scans, assignments, boxes, or exceptions.

### First administrator setup on Render Free

The first administrator is created through a one-time HTTPS setup page; `DATABASE_URL` and the administrator password never go in chat, source control, a URL, or application logs.

1. Generate a high-entropy token **locally** without printing any existing secret:

   ```bash
   openssl rand -base64 32
   ```

   Copy the generated value directly into the next Render field. To generate a password locally without echoing it, use `read -r -s ADMIN_PASSWORD; echo` in a terminal, then discard the shell variable after use.
2. In the Render dashboard, open the DockFlow web service, select **Environment**, click **Add Environment Variable**, set key `DOCKFLOW_SETUP_TOKEN`, paste the generated token as its value, and click **Save Changes**. Keep `DATABASE_URL` and `NODE_ENV=production` as existing environment variables; never paste either value into chat.
3. Click **Manual Deploy** → **Deploy latest commit** and wait for the deploy to become live. Render's HTTPS URL is the only supported production setup URL.
4. Open `https://YOUR-RENDER-SERVICE.onrender.com/setup`. Enter the setup token in the first field, an administrator email, and a unique 12+ character password. Click **Create administrator**. The token is sent in an HTTPS request header and the password in the HTTPS request body; neither is placed in the URL.
5. Confirm the success page, click **Go to sign in**, and sign in at the normal service URL. Verify the `admin` role, then create a worker and manager from **Users** and verify logout/login.
6. In Render **Environment**, remove `DOCKFLOW_SETUP_TOKEN` and click **Save Changes**, then deploy again. The setup endpoint is also permanently disabled after the first active admin is created by the database-backed `admin_bootstrap` state. If an active admin already exists, the page returns the same generic setup error and cannot create or replace one.

If the token is mistyped, setup is attempted over HTTP, or the endpoint receives too many attempts, it returns a generic error. The endpoint allows five attempts per client address per 15 minutes, compares tokens in constant time, uses a transaction lock, and never logs submitted credentials.

### Post-deployment authentication checklist

- Sign in from the Render URL, verify the admin role is shown, create one worker and one manager, and verify logout/login.
- Verify a worker can receive and use PDA Scan, Locations, and Exceptions, but receives 403 from `/api/history`, `/api/archive`, `/api/day/reset`, and `/api/users`.
- Verify the admin can change roles, reset a password, disable/reactivate users, and cannot disable or demote the last active admin.
- Verify Android PDA camera/manual scan, duplicate scans, exact 50 locations, Chicago rollover, and historical archive data.

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

Duplicate box scans remain protected by the unique PostgreSQL constraint and transaction lock. Every scan persists one captured timestamp (`timestamptz`) and the matching America/Chicago warehouse date, SKU, box ID, quantity, numbered location (or an exception), user, and device. Assignment selection is serialized per daily cycle so capacity routing cannot over-allocate under concurrent scans. CSV location import is no longer part of normal operation; the numbered physical layout is provisioned by the schema.

## History / Archive

The History tab queries PostgreSQL by warehouse-local date range and renders each active date as an expandable folder. A day includes every assignment's SKU, box, quantity, numbered location, inbound number, client, user, device, and scan time, plus totals and exceptions. Search filters are parameterized and indexed for date, SKU, Box ID, inbound number, client, and location. Export a single day by using the same date for `from` and `to`, or export a range. Starting a new day closes the current cycle only; it never deletes scan, box, assignment, or exception history.

## Tests

```bash
npm test
```

## Authentication and roles

All API and application routes (except `/api/health` and login) require a database-backed session. Passwords are bcrypt-hashed, sessions are short-lived and stored as hashes, and the browser receives an HttpOnly SameSite cookie (Secure in production). State-changing requests are same-origin checked. Roles are exactly `admin`, `manager`, and `worker`: administrators have full access; managers can operate receiving, exceptions, history, archive and reports but cannot manage users or reset a day; workers are limited to Receiving, PDA Scan, Locations and Exceptions. Unauthorized direct URLs and API calls return 401/403.

Run the schema migration before starting a deployment and periodically clean expired sessions (login also performs cleanup; `DELETE FROM sessions WHERE expires_at <= now()` is safe to schedule). The administrator Users page can create and disable accounts, while preventing removal or demotion of the last active administrator. The legacy `db:create-admin` script remains available for controlled local recovery, but the Render production path is the one-time `/setup` flow above.
