# filo — Plug & Play Permanent Links

Upload any file → get `https://filo.<subdomain>.workers.dev/p/8xK29m` that never breaks, even if the original site deletes it.

* **GitHub = code only.** Files go to **R2** (free 10GB), never committed.
* **One deploy.** Worker serves frontend + API + files via `[assets]` in `wrangler.toml`.
* **Permanent URLs.** `nanoid` 8, no collision, independent of filename.
* **Dashboard** shows filename, size, date, link, copy button.
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
npm run deploy
# -> https://filo.<subdomain>.workers.dev
#    https://filo.<subdomain>.workers.dev/p/8xK29m
```

Open the Worker URL → drag any file → copy `/p/<id>` link for sharing.

No custom domain, no paid hosting, no manual HTML/JSON.

## How It Works

* **Worker** (`worker.js`): `POST /api/upload` validates any file (<25MB), detects `Content-Type`, generates `p/<id>` in R2, inserts D1 row. `GET /p/:id` (and `HEAD`) streams from R2 with correct type + `Cache-Control: public, immutable` + `Content-Disposition: inline; filename*` (legacy `p/<id>.pdf` still served, Range + ETag supported).
* **D1** (`schema.sql`): `docs(id, filename, size, uploaded_at, title, category)`.
* **Frontend** (`public/index.html`, `public/app.js`): drag-drop, progress, `GET /api/list` dashboard. No token — open upload.

## Free Tier

* Worker 100k req/day
* R2 10GB, 10M ops/month, zero egress
* D1 5GB, 5M reads/day

## Security

* `GET /p/*` public, `POST /api/upload` + `DELETE /api/delete/:id` open (no auth — single user, private Worker URL). Validates 25MB limit, sanitizes filename for `Content-Disposition`, validates `x-forwarded-host` to prevent host injection.
* To add auth later: re-add token check in `worker.js` and `wrangler secret put UPLOAD_TOKEN`. Cloudflare handles HTTPS/DDoS.

## GitHub Actions (auto-deploy)

`.github/workflows/deploy.yml` runs `wrangler deploy` on push to `main` (requires `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` secrets).

## Local Dev

```bash
npm run dev # http://localhost:8787
```

Need to change bucket/db names? Edit `wrangler.toml` `r2_buckets` / `d1_databases`.
