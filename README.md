# filo — Plug & Play Permanent Links

Upload any file → get `https://filo-hub.pages.dev/p/8xK29m` that never breaks, even if the original site deletes it.

* **GitHub = code only.** Files go to **R2** (free 10GB), never committed.
* **Two deploys, one codebase.** `worker.js` is the single source; a vite plugin (`vite.config.js`) regenerates `public/_worker.js` from it on every `npm run build`, so Workers (`filo.<sub>.workers.dev`) and Pages (`filo-hub.pages.dev`) always run identical logic. Never edit `public/_worker.js` by hand.
* **Permanent URLs.** `nanoid` 8, id allocated by D1 insert-first (PK is the source of truth — concurrent uploads can never collide), independent of filename.
* **Dashboard** (Svelte 5 + Tailwind): multi-file drag/drop/paste upload with live progress + cancel, server-side search, categories, rename, bulk delete, image thumbnails, sorting, activity feed, dark mode.
* Supports any file type — PDF, JPG, PNG, DOCX, XLSX, ZIP, MP4, etc. — with correct `Content-Type`. Every upload records an **md5 checksum** (R2's own etag of the stored bytes) so you can prove a download is byte-identical years later.

## Plug-and-Play Deploy

```bash
npm install
# 1. Create resources (once)
npx wrangler r2 bucket create filo-files
npx wrangler d1 create filo-db   # copy database_id -> wrangler.toml + wrangler.pages.toml

# 2. Apply migrations (docs + etag + actions audit table)
npm run db:migrate               # local
npm run db:migrate:remote        # production

# 3. Deploy
npm run deploy          # Worker + assets (includes the weekly cron)
npm run deploy:pages    # filo-hub.pages.dev (primary)
```

Open the URL → drag files (or paste) → copy `/p/<id>` links for sharing.

No custom domain, no paid hosting, no manual HTML/JSON.

## How It Works

* **Worker** (`worker.js`, synced to `public/_worker.js`): `POST /api/upload` validates any file (<25MB), detects `Content-Type`, streams the file to R2 without buffering a full second copy (only the first 2KB is read, to sniff a title), stores R2's md5 etag as the checksum, and allocates the id by inserting the D1 row first. Uploads over the storage quota are rejected with HTTP 507 before anything is written. `GET /p/:id` (and `HEAD`) streams from R2 with correct type + `Cache-Control: public, immutable` + `Content-Disposition` + `X-Content-Type-Options: nosniff` (legacy `p/<id>.pdf` still served; full Range support incl. suffix `bytes=-N`; ETag).
* **API surface**: `/api/health` (public, reports auth mode) · `/api/list` (`?q=` server-side search over filename/title/id, `?category=`, `?sort=name|size|date`, `?dir=`, `?offset=` pagination, returns true `total`) · `/api/upload` · `/api/delete/:id` · `/api/rename/:id` (title/category) · `/api/activity` (audit feed) · `/api/storage` (SUM(size) + configured `quota`) · `/api/reconcile` (on-demand maintenance).
* **Audit trail**: every upload/delete/rename/cleanup writes to the `actions` table (best-effort — an audit failure never fails your operation). `GET /api/activity` shows the last 50.
* **Maintenance (`reconcile()`)**: cross-checks D1 rows against R2 — drops rows whose object vanished, migrates legacy `p/<id>.pdf` objects to `p/<id>`, reports drift. Runs weekly via the Worker cron (`[triggers]` in wrangler.toml) and on demand via the dashboard's "Run cleanup" button or `POST /api/reconcile`. Orphaned objects (row missing) are reported, never auto-deleted.
* **D1** (`migrations/`): `docs(id, filename, size, uploaded_at, title, category, etag)` + `actions` audit table. Title keeps its spaces; only the stored filename is squished.
* **Frontend** (`src/App.svelte`, Svelte 5): queue multiple files, paste images straight from the clipboard, per-batch progress with a Cancel button, debounced server-side search, category sidebar, inline rename (✎), select-mode bulk delete, image thumbnails, sortable columns, relative dates, activity feed, dark mode (🌙 toggle, follows system by default). If the server has a token configured, the dashboard shows a token prompt in the header and remembers it in `localStorage`; in open mode it shows an amber warning banner instead.

## Free Tier

* Worker/Pages 100k req/day
* R2 10GB, 10M ops/month, zero egress
* D1 5GB, 5M reads/day

## Security

* `GET /p/*` is public — that's the point (permanent shareable links).
* **Token (optional, recommended):** without any config everything is open (single user, private URL) — the dashboard shows an amber "open mode" banner reminding you of this. Set a token to lock the mutating/reading API:
  ```bash
  npx wrangler secret put UPLOAD_TOKEN            # Worker
  npx wrangler pages secret put UPLOAD_TOKEN --project-name filo-hub   # Pages
  ```
  When set, all `/api/*` routes except `/p/*` and `/api/health` require header `x-upload-token: <token>` (or `Authorization: Bearer <token>`). The dashboard picks it up automatically. The token check hashes both sides (SHA-256) before comparing, so neither the token's length nor a mismatch position leaks through timing.
* **Storage quota:** the dashboard bar and a server-side upload check use `MAX_STORAGE_MB` (default `10240` = the R2 free tier's 10GB):
  ```bash
  npx wrangler pages secret put MAX_STORAGE_MB --project-name filo-hub   # e.g. 2048 = 2GB
  ```
  Uploads that would exceed it are rejected with HTTP 507 *before* anything is written to R2.
* **No cross-origin API:** CORS headers are never reflected, so other websites can't drive-by upload/delete from visitors' browsers. Files remain embeddable cross-origin via `<img>`/`<video>`/direct links (not CORS-gated).
* **XSS hardened:** SVG/HTML and unknown types are served `Content-Disposition: attachment` (only images/video/audio/pdf/text/csv/json render inline) + `nosniff`, so uploaded files can never run script on the filo origin.
* Validates 25MB limit (self-imposed; CF allows 100MB), sanitizes filenames for `Content-Disposition`, validates `x-forwarded-host` against host injection.
* **Recommended ops hardening** (outside the repo): enable **R2 object versioning** on `filo-files` so deletes are recoverable, and turn on **D1 Time Travel** (30-day PITR) for the metadata DB.

## Tests

Real integration tests run the worker against miniflare's real D1/R2 (`@cloudflare/vitest-pool-workers`), in two isolated projects — open mode and token+quota mode:

```bash
npm test        # 40+ assertions: auth gate, upload roundtrip + audit, pagination,
                # server search (incl. LIKE-escaping), sort allowlist, rename,
                # range suite (bounded/open/suffix/416), XSS disposition policy,
                # delete + legacy cleanup, reconcile (dead rows, .pdf migration)
```

CI runs tests on every push/PR and gates both deploys on them.

## GitHub Actions

`.github/workflows/deploy.yml`:
* **push to main** → `test` job, then deploy **both** the Worker and Pages (`filo-hub.pages.dev`) — Pages config comes from `wrangler.pages.toml` (no more toml-swap).
* **PRs** → `test` job + a throwaway **Pages preview** at `pr-<n>.filo-hub.pages.dev`, commented on the PR. Previews share production bindings — never upload anything sensitive to one.

Requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets.

## Local Dev

Two terminals — vite for the Svelte frontend (proxies `/api` + `/p`), wrangler for the Worker:

```bash
npm run db:migrate             # once, local D1 (docs + etag + actions)
npm run dev          # terminal 1: Worker + local R2/D1  -> http://localhost:8787
npm run dev:vite     # terminal 2: frontend              -> http://localhost:5173
```

`npm run dev` alone serves the built `dist/` (stale until you `npm run build`) — use the two-terminal flow for frontend work. To test the token/quota locally, put `UPLOAD_TOKEN`/`MAX_STORAGE_MB` in `.dev.vars` (gitignored). Fire the weekly cron manually: `npm run cron:local` (needs `npm run dev` up).

Need to change bucket/db names? Edit them in `wrangler.toml` **and** `wrangler.pages.toml`.
