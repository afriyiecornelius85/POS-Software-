# Akopharmah POS Render Backend

Deploy this repository as a **Render Web Service**, not a Static Site. The Node server serves both the browser application and the `/api/*` routes.

## Render Settings

The included `render.yaml` configures:

```text
Runtime: Node
Build command: npm ci
Start command: npm start
Health check: /health
Persistent disk mount: /var/data
Data file: /var/data/akopharmah-sync.json
PostgreSQL database: akopharmah-pos-db
Database environment variable: DATABASE_URL
```

After deployment, open:

```text
https://YOUR-SERVICE.onrender.com/health
```

The response should report `"ok": true`, service name `akopharmah-pos-sync`, and persistent storage enabled.

The persistent disk is now a migration and fallback path for the older JSON-file storage. Production deployments should use PostgreSQL through `DATABASE_URL`.

## PostgreSQL Production Storage

The server now supports PostgreSQL for production data. If `DATABASE_URL` or `AKOPHARMAH_DATABASE_URL` is set, PostgreSQL is used automatically. If no database URL is set, the server keeps using the JSON data file for local development.

PostgreSQL stores the current application state in one table named `akopharmah_state`. This is a low-risk production upgrade because it keeps the current API and browser code unchanged while moving the data off the Render disk. The first time the server starts with an empty PostgreSQL database, it imports the existing JSON file from `AKOPHARMAH_DATA_FILE` if that file exists. If no JSON file exists, it creates a fresh database from the seed catalog and the bootstrap director password.

Recommended first migration:

1. Keep `AKOPHARMAH_DATA_FILE=/var/data/akopharmah-sync.json` and the `/var/data` disk for the first PostgreSQL deploy.
2. Deploy the updated code and let the service start once.
3. Open `/health` and confirm `storage.mode` is `postgres`.
4. Sign in and confirm branches, users, patients, stock, sales history, suppliers, and purchases are present.
5. After you have confirmed the import, create a Render PostgreSQL backup or snapshot.
6. Only after that confirmation, you may remove the Render disk and `AKOPHARMAH_DATA_FILE` from the service. Keep a separate exported backup before removing the disk.

Important scaling note: run one web-service instance until sessions are moved out of server memory. PostgreSQL removes the disk dependency, but multiple web instances still need shared session storage or users may be asked to sign in again when requests hit a different instance.

For a new database, set `AKOPHARMAH_BOOTSTRAP_PASSWORD` to a strong secret in Render. New Blueprint creation prompts for it because `render.yaml` marks it `sync: false`. For an existing Render service, add it manually under Environment before the first startup with an empty disk. The initial username is `director` unless `AKOPHARMAH_BOOTSTRAP_USERNAME` is changed.

## Password Security

Backend users store bcrypt cost-10 hashes in `passwordHash`. Plaintext passwords and browser offline verifiers are excluded from API responses and sync payloads.

Successful login returns an opaque, expiring session token. Protected API requests use `Authorization: Bearer <token>`; role and branch headers are never trusted for authorization. Login attempts are throttled, and all data, inventory, sales, user, and audit routes require a valid session.

The static server only exposes the POS application assets. Database JSON, source configuration, vendor files, backups, and password hashes are not web-accessible. The public browser seed is generated without user credentials or patient records.

## Browser Build

The browser starts from `js/app.js`, a native ES module. It loads the public seed JSON, imports the generated isolated runtime, and initializes the application after the DOM is ready.

Run this after changing files under `js/modules/`:

```powershell
npm run build
```

`npm start` and `npm test` run that build automatically. Dynamic views use `js/core/dom-renderer.js`, which sanitizes markup and patches existing keyed DOM nodes instead of resetting whole containers.

Run this after restoring a legacy JSON database:

```powershell
npm run migrate-passwords
```

The bcrypt implementation is included under `vendor/`, so Render does not need to download a separate bcrypt package. Password requests require HTTPS except during local loopback testing.

Offline login stores a salted PBKDF2 verifier, never a plaintext password. The verifier expires after seven days and must be renewed by a successful online login. Server-side permissions still govern every synchronized write.

## Production Startup

Fresh deployments contain the medicine catalog but start with zero stock and only the built-in Walk-in customer. They do not create demonstration patients or fictional opening balances.

1. Sign in with the bootstrap director account and confirm the branch list.
2. Create named staff accounts, change the bootstrap password, and remove shared credentials before staff begin work.
3. Enter opening inventory through verified GRNs, or import a reviewed inventory file as a director.
4. Use Push Data only when the browser already contains verified production balances. This operation is director-only.
5. Confirm one test sale, return, purchase receipt, and branch switch before rollout.

Summaries, history, returns, suppliers, purchases, expiry alerts, and stock calculations use the currently selected branch. Directors can switch branches; other staff only see assigned branches.

## Local Testing

```powershell
npm start
```

Useful API routes:

```text
GET    /health
POST   /api/auth/login
POST   /api/auth/logout
POST   /api/users
DELETE /api/users
GET    /api/drugs?branch=all
GET    /api/sales
POST   /api/sales
POST   /api/returns
POST   /api/purchases
POST   /api/stock-transfers
POST   /api/stock-writeoffs
GET    /api/sync
POST   /api/sync
```
