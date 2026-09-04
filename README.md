# filo — Plug & Play Permanent Links

Upload any file → get `https://filo-hub.pages.dev/p/8xK29m` that never breaks, even if the original site deletes it.

* **GitHub = code only.** Files go to **R2** (free 10GB), never committed.
* **Two deploys, one codebase.** `worker.js` is the single source; a vite plugin (`vite.config.js`) regenerates `public/_worker.js` from it on every `npm run build`, so Workers (`filo.<sub>.workers.dev`) and Pages (`filo-hub.pages.dev`) always run identical logic. Never edit `public/_worker.js` by hand.
* **Permanent URLs.** `nanoid` 8, id allocated by D1 insert-first (PK is the source of truth — concurrent uploads can never collide), independent of filename.
* **Dashboard** (Svelte 5 + Tailwind) shows filename, size, date, link, copy button.
* Supports any file type — PDF, JPG, PNG, DOCX, XLSX, ZIP, MP4, etc. — with correct `Content-Type`.

## Plug-and-Play Deploy

```bash
npm install
# 1. Create resources (once)
npx wrangler r2 bucket create filo-files
npx wrangler d1 create filo-db   # copy database_id -> wrangler.toml

# 2. Apply schema
npx wrangler d1 execute filo-db --file=./schema.sql

# 3. Deploy
npm run deploy          # Worker + assets
npm run deploy:pages    # filo-hub.pages.dev (primary)
```

Open the URL → drag any file → copy `/p/<id>` link for sharing.

No custom domain, no paid hosting, no manual HTML/JSON.

## How It Works

* **Worker** (`worker.js`, synced to `public/_worker.js`): `POST /api/upload` validates any file (<25MB), detects `Content-Type`, streams the file to R2 without buffering a full second copy (only the first 2KB is read, to sniff a title), and allocates the id by inserting the D1 row first, then stores `p/<id>`. Uploads over the storage quota are rejected with HTTP 507 before anything is written. `GET /p/:id` (and `HEAD`) streams from R2 with correct type + `Cache-Control: public, immutable` + `Content-Disposition` + `X-Content-Type-Options: nosniff` (legacy `p/<id>.pdf` still served, full Range support incl. suffix `bytes=-N`, ETag). `GET /api/list` paginates (`?offset=`, 200/page) and returns the true `total`; `GET /api/storage` is a single `SUM(size)` query and returns the configured `quota`.
* **D1** (`schema.sql`): `docs(id, filename, size, uploaded_at, title, category)`. `title` keeps its spaces; only the stored filename is squished.
* **Frontend** (`src/App.svelte`, Svelte 5): drag-drop upload with real XHR progress %, `GET /api/list` dashboard with "Load more" pagination and true file count. If the server has a token configured, the dashboard shows a token prompt in the header and remembers it in `localStorage`; in open mode it shows a warning banner instead.

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
  When set, `POST /api/upload`, `DELETE /api/delete/:id`, `GET /api/list`, `GET /api/storage` require header `x-upload-token: <token>` (or `Authorization: Bearer <token>`). The dashboard picks it up automatically. The token check hashes both sides (SHA-256) before comparing, so neither the token's length nor a mismatch position leaks through timing.
* **Storage quota:** the dashboard bar and a server-side upload check use `MAX_STORAGE_MB` (default `10240` = the R2 free tier's 10GB):
  ```bash
  npx wrangler pages secret put MAX_STORAGE_MB --project-name filo-hub   # e.g. 2048 = 2GB
  ```
  Uploads that would exceed it are rejected with HTTP 507 *before* anything is written to R2.
* **No cross-origin API:** CORS headers are never reflected, so other websites can't drive-by upload/delete from visitors' browsers. Files remain embeddable cross-origin via `<img>`/`<video>`/direct links (not CORS-gated).
* **XSS hardened:** SVG/HTML and unknown types are served `Content-Disposition: attachment` (only images/video/audio/pdf/text/csv/json render inline) + `nosniff`, so uploaded files can never run script on the filo origin.
* Validates 25MB limit (self-imposed; CF allows 100MB), sanitizes filenames for `Content-Disposition`, validates `x-forwarded-host` against host injection.

## GitHub Actions (auto-deploy)

`.github/workflows/deploy.yml` builds once, then deploys **both** the Worker and Pages (`filo-hub.pages.dev`) on push to `main` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets).

## Local Dev

Two terminals — vite for the Svelte frontend (proxies `/api` + `/p`), wrangler for the Worker:

```bash
npx wrangler d1 execute filo-db --local --file=./schema.sql   # once, local D1
npm run dev          # terminal 1: Worker + local R2/D1  -> http://localhost:8787
npm run dev:vite     # terminal 2: frontend              -> http://localhost:5173
```

`npm run dev` alone serves the built `dist/` (stale until you `npm run build`) — use the two-terminal flow for frontend work. To test the token locally, put `UPLOAD_TOKEN=<value>` in `.dev.vars` (gitignored).

Need to change bucket/db names? Edit `wrangler.toml` `r2_buckets` / `d1_databases`.
