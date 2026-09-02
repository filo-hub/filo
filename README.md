# filo — Plug & Play Permanent Links

Upload any file (PDF, image, doc, zip, etc.) → get `https://filo-hub.pages.dev/p/8xK29m` (or `https://filo.dinesh-io.workers.dev/p/8xK29m`) that never breaks, even if the original site deletes it.

* **GitHub = code only.** Files go to **R2** (free 10GB), never committed.
* **One deploy.** Worker serves frontend + API + files.
* **Permanent URLs.** ID random (nanoid 8), no collision, independent of filename/original URL.
* **Dashboard** shows filename, size, date, link, copy button.
* Supports any file type — PDF, JPG, PNG, DOCX, XLSX, ZIP, MP4, etc. — with correct `Content-Type`.

## Plug-and-Play Deploy (3 commands)

```bash
npm install
# 1. Create resources (once)
npx wrangler r2 bucket create filo-files
npx wrangler d1 create filo-db   # copy database_id -> wrangler.toml

# 2. Apply schema
npx wrangler d1 execute filo-db --file=./schema.sql

# 3. Set upload password (keep private, only you upload)
npx wrangler secret put UPLOAD_TOKEN
# enter e.g. my-secure-token-123

# 4. Deploy
npm run deploy
# -> https://filo.dinesh-io.workers.dev
# Pages (clean, no suffix): https://filo-hub.pages.dev/p/8xK29m (proxies to Worker)
```

Open either URL (`filo-hub.pages.dev` clean `pages.dev`, or `filo.dinesh-io.workers.dev`) → save token in the UI → drag any file → copy `/p/<id>` link for Facebook/WhatsApp/YouTube.

No custom domain, no paid hosting, no manual HTML/JSON.

## How It Works

* **Worker** (`worker.js:14` `nanoid`, `worker.js:120` upload, `worker.js:40` serve): `POST /api/upload` validates any file (<25MB), detects `Content-Type` via extension/mime, generates `p/<id>` in R2, inserts D1 row. `GET /p/:id` streams from R2 with correct type + `Cache-Control: immutable` (legacy `p/<id>.pdf` still served).
* **D1** (`schema.sql:2`): `docs(id, filename, size, uploaded_at, title, category)`.
* **Frontend** (`public/index.html`, `public/app.js`): drag-drop, progress, `GET /api/list` dashboard.

## Free Tier

* Worker 100k req/day
* R2 10GB, 10M ops/month, zero egress
* D1 5GB, 5M reads/day
* ~500 PDFs/yr at 3MB = well within free.

## Security

* `GET /p/*` public, `POST /api/upload` + `DELETE` require `Authorization: Bearer <UPLOAD_TOKEN>` (`worker.js:35`). No token = anyone can upload (dev mode) — set token in prod.
* Validates 25MB limit, stores original `Content-Type`; no executable handling.

## GitHub Actions (optional auto-deploy)

```yaml
# .github/workflows/deploy.yml
on: { push: { branches: [main] } }
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npx wrangler deploy
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

## Local Dev

```bash
npm run dev # http://localhost:8787
```

Need to change bucket/db names? Edit `wrangler.toml:10` and `wrangler.toml:15`.
