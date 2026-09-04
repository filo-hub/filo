/**
 * filo — Cloudflare Worker (SINGLE SOURCE, two deploy targets)
 *
 * Workers: `wrangler deploy` — main = worker.js, [assets] = dist (wrangler.toml)
 * Pages:   public/_worker.js — AUTO-GENERATED from this file by the vite plugin
 *          in vite.config.js on every `npm run build`. Do not edit that copy.
 *
 * Bindings: BUCKET (R2), DB (D1). Optional secret UPLOAD_TOKEN:
 *   - unset  → open mode (single user, private URL) — current default
 *   - set    → POST /api/upload, DELETE /api/delete/*, GET /api/list and
 *              GET /api/storage require header `x-upload-token: <token>`
 *              (or `Authorization: Bearer <token>`). GET /p/<id> stays public.
 * Optional var MAX_STORAGE_MB: storage quota for the dashboard bar and the
 * server-side upload check (default 10240 = the R2 free tier's 10GB).
 *
 * Routes: /api/health, /api/list (?q= search, ?sort=, ?dir=, ?offset=),
 *   /api/upload, /api/delete/:id, /api/rename/:id, /api/activity,
 *   /api/storage, /api/reconcile (on-demand cron), /p/:id (+HEAD, Range).
 * scheduled(): weekly cron — reconcile D1 against R2 (see reconcile()).
 */

const ID_LEN = 8;
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SIZE = 25 * 1024 * 1024; // self-imposed limit (CF Workers allows up to 100MB)

// content-type map by extension (fallback when the browser sends no type)
const MIME_MAP = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav", zip: "application/zip",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", json: "application/json",
};

// Types the browser may render inline. SVG and HTML are deliberately excluded:
// served inline on our own origin they run script with dashboard access
// (stored XSS). Anything not listed is forced to download instead.
const INLINE_TYPES = new Set(["application/pdf", "text/plain", "text/csv", "application/json"]);
function isInlineType(type) {
  if (type === "image/svg+xml") return false;
  return (
    type.startsWith("image/") ||
    type.startsWith("video/") ||
    type.startsWith("audio/") ||
    INLINE_TYPES.has(type)
  );
}

// Host validation for x-forwarded-host (prevent header injection / XSS)
const SAFE_HOST_RE = /^[a-z0-9.-]+\.[a-z]{2,}$/i;
function getSafeHost(req, url) {
  const forwarded = req.headers.get("x-forwarded-host");
  if (forwarded && SAFE_HOST_RE.test(forwarded) && forwarded.length <= 253 && !forwarded.includes("..")) {
    return forwarded;
  }
  return url.host;
}

function extOf(filename) {
  const m = filename.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}
function guessContentType(filename, provided) {
  if (provided && provided !== "application/octet-stream" && provided !== "") return provided;
  const ext = extOf(filename);
  return MIME_MAP[ext] || "application/octet-stream";
}

function nanoid(len = ID_LEN) {
  const arr = new Uint8Array(len);
  crypto.getRandomValues(arr);
  let id = "";
  for (let i = 0; i < len; i++) id += ID_CHARS[arr[i] % 62];
  return id;
}

// No CORS reflection: reflecting arbitrary Origins would let any website
// drive-by upload into R2 (or delete files) from visitors' browsers. Same-origin
// requests need no CORS headers; files stay embeddable cross-origin via
// <img>/<video>/direct links, which are not CORS-gated.

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", "X-Content-Type-Options": "nosniff" },
  });
}

// constant-time compare: hash both sides with SHA-256 first — the fixed-length
// digest hides the token's length and mismatch position, and the digest
// comparison loop runs in constant time.
async function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const digest = async (s) =>
    new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(s)));
  const da = await digest(a);
  const db = await digest(b);
  if (da.length !== db.length) return false;
  let diff = 0;
  for (let i = 0; i < da.length; i++) diff |= da[i] ^ db[i];
  return diff === 0;
}

async function authorized(req, env) {
  const want = env.UPLOAD_TOKEN;
  if (!want) return true; // open mode — no secret configured
  const auth = req.headers.get("Authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-upload-token") || "";
  return await safeEqual(got, want);
}

// ---- storage quota (default = 10GB R2 free tier) -------------------------
const DEFAULT_QUOTA_MB = 10 * 1024;
function storageQuotaBytes(env) {
  const mb = Number(env.MAX_STORAGE_MB);
  return Number.isFinite(mb) && mb > 0 ? Math.floor(mb * 1024 * 1024) : DEFAULT_QUOTA_MB * 1024 * 1024;
}
function fmtMB(bytes) {
  return (bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, "");
}
// SUM(size) from D1, or null if it can't be read (quota check becomes advisory)
async function usedBytes(env) {
  try {
    const row = await env.DB.prepare("SELECT COALESCE(SUM(size), 0) AS total FROM docs").first();
    return row?.total ?? null;
  } catch {
    return null;
  }
}

// Best-effort audit trail — never throws (an audit failure must not fail
// the user's upload/delete), just logs so it shows up in observability.
async function audit(env, action, docId = null, filename = null, detail = null) {
  try {
    await env.DB.prepare("INSERT INTO actions (action, doc_id, filename, detail, ts) VALUES (?, ?, ?, ?, ?)")
      .bind(action, docId, filename, detail, Date.now())
      .run();
  } catch (e) {
    console.error("audit write failed:", e);
  }
}

// LIKE pattern for search: % wildcards, but the user's own % and _ are
// escaped so a query of "50%" doesn't match everything.
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}


function sanitizeFilename(filename) {
  // Strip path, control chars, quotes; limit length; fallback to id
  let s = String(filename).split("/").pop().split("\\").pop();
  s = s.replace(/[\r\n"]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!s) s = "file";
  if (s.length > 200) s = s.slice(0, 200);
  return s;
}

function contentDisposition(filename, contentType) {
  const safe = sanitizeFilename(filename);
  const encoded = encodeURIComponent(safe).replace(/'/g, "%27");
  // Use both filename and filename* (RFC 5987) for UTF-8 support
  const fallback = safe.replace(/"/g, "_");
  const type = isInlineType(contentType) ? "inline" : "attachment";
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function autoFilename(originalName, titleInput, buf) {
  let base = (titleInput || "").trim();
  if (!base) {
    const orig = (originalName || "").replace(/\.[^/.]+$/, "").trim();
    if (orig && orig !== "file" && orig !== "blob") {
      base = orig;
    }
  }
  if (!base && buf) {
    try {
      const text = new TextDecoder().decode(buf.slice(0, 2000));
      // look for first meaningful line (alphanumeric)
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[A-Za-z0-9]{3,}/.test(l));
      if (lines[0]) base = lines[0].slice(0, 10);
    } catch {}
  }
  if (!base) {
    base = (originalName || "file").replace(/\.[^/.]+$/, "") || "file";
  }
  base = base.replace(/\s+/g, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 10) || "file";
  const ext = extOf(originalName) || "bin";
  const d = new Date();
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  const check = nanoid(8);
  return `${base}${dd}${mm}${yyyy}${check}.${ext}`;
}

// Weekly maintenance (cron + POST /api/reconcile): make D1 agree with R2.
//  - row whose object is missing (delete raced a failed put)  → row dropped
//  - legacy object p/<id>.pdf with a row but no p/<id>          → copied to p/<id>
//  - R2 object with no row (manual bucket writes, drift)       → reported only
//    (never auto-deleted — an object is data, a row is metadata)
async function reconcile(env) {
  const report = { checked: 0, droppedRows: 0, migrated: 0, orphans: [], errors: 0 };
  let rows;
  try {
    ({ results: rows } = await env.DB.prepare("SELECT id, filename, etag FROM docs").all());
  } catch (e) {
    report.errors++;
    console.error("reconcile: list failed:", e);
    return report;
  }
  for (const row of rows || []) {
    report.checked++;
    let obj = null;
    try {
      obj = await env.BUCKET.get(`p/${row.id}`);
      if (!obj) {
        // legacy layout: object lives at p/<id>.pdf — copy it to p/<id>
        const legacy = await env.BUCKET.get(`p/${row.id}.pdf`);
        if (legacy) {
          await env.BUCKET.put(`p/${row.id}`, legacy.body, {
            httpMetadata: legacy.httpMetadata,
            customMetadata: legacy.customMetadata,
          });
          report.migrated++;
          continue;
        }
      }
    } catch (e) {
      report.errors++;
      console.error(`reconcile: head ${row.id} failed:`, e);
      continue;
    }
    if (!obj) {
      // no object anywhere — the row is a dead link
      try {
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(row.id).run();
        report.droppedRows++;
      } catch (e) {
        report.errors++;
        console.error(`reconcile: drop row ${row.id} failed:`, e);
      }
    } else {
      obj.body?.cancel?.(); // release the full-object stream we only peeked at
    }
  }
  return report;
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const path = url.pathname;

    // CORS preflight — no CORS headers granted, so cross-origin preflights
    // fail in the browser. Same-origin requests never preflight.
    if (req.method === "OPTIONS") return new Response(null, { status: 204 });

    // Early check for missing bindings (nice error instead of raw exception)
    if (!env.BUCKET || !env.DB) {
      if (path.startsWith("/api/") || path.startsWith("/p/")) {
        return json({ error: "Server misconfigured: missing BUCKET or DB binding" }, 500);
      }
    }

    // Permanent file serving — public, immutable (any file type)
    if (path.startsWith("/p/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
      }
      const id = path.slice(3).split("/")[0].split(".")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) {
        return new Response("Not found", { status: 404 });
      }
      // Try both new key (p/<id>) and legacy (p/<id>.pdf) for backward compat
      let obj = await env.BUCKET.get(`p/${id}`);
      let key = `p/${id}`;
      if (!obj) {
        obj = await env.BUCKET.get(`p/${id}.pdf`);
        key = `p/${id}.pdf`;
      }
      if (!obj) return new Response("File not found", { status: 404 });

      // Get original filename and content-type from D1
      let filename = id;
      let contentType = null;
      try {
        const row = await env.DB.prepare("SELECT filename FROM docs WHERE id = ?").bind(id).first();
        if (row?.filename) filename = row.filename;
      } catch (_) {}
      // Prefer stored httpMetadata, fallback to filename guess
      contentType = obj.httpMetadata?.contentType || guessContentType(filename, "");

      const headers = new Headers();
      obj.writeHttpMetadata(headers);
      if (contentType) headers.set("Content-Type", contentType);
      // SVG/HTML/unknown types download instead of rendering inline —
      // inline script in them would run on our origin (stored XSS).
      headers.set("Content-Disposition", contentDisposition(filename, contentType));
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "public, immutable, max-age=31536000");
      if (obj.httpEtag) headers.set("ETag", obj.httpEtag);
      headers.set("Accept-Ranges", "bytes");

      const range = req.headers.get("Range");
      if (range) {
        // Single range only: "bytes=a-b", "bytes=a-", or suffix "bytes=-n"
        const m = range.match(/^bytes=(\d*)-(\d*)$/);
        if (m && (m[1] || m[2])) {
          let start, end;
          if (!m[1]) {
            // suffix range: last n bytes
            const n = parseInt(m[2], 10);
            start = Math.max(0, obj.size - n);
            end = obj.size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = m[2] ? parseInt(m[2], 10) : obj.size - 1;
          }
          // Validate range
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= obj.size || end >= obj.size) {
            headers.set("Content-Range", `bytes */${obj.size}`);
            return new Response("Range Not Satisfiable", { status: 416, headers });
          }
          const sliced = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
          if (sliced) {
            headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
            headers.set("Content-Length", String(end - start + 1));
            if (req.method === "HEAD") {
              return new Response(null, { status: 206, headers });
            }
            return new Response(sliced.body, { status: 206, headers });
          }
        }
      }

      headers.set("Content-Length", String(obj.size));
      if (req.method === "HEAD") {
        return new Response(null, { headers });
      }
      return new Response(obj.body, { headers });
    }

    // API: Health — public (uptime checks). `auth` lets the dashboard show
    // its open-mode warning banner without an authenticated round-trip.
    if (path === "/api/health") {
      return json({ ok: true, time: Date.now(), auth: Boolean(env.UPLOAD_TOKEN) });
    }

    // Everything below is the private API — token-gated when UPLOAD_TOKEN is set.
    if (!(await authorized(req, env))) return json({ error: "Unauthorized" }, 401);

    // API: List — newest first, paginated via ?offset= (default 0).
    // ?q= searches server-side over filename/title/id (the dashboard can
    // only filter what it has loaded). ?category= filters, ?sort=name|size|date,
    // ?dir=asc|desc. Returns `total` = true count of matching rows.
    if (path === "/api/list" && req.method === "GET") {
      try {
        const offset = Math.max(0, Math.min(100000, parseInt(url.searchParams.get("offset") || "0", 10) || 0));
        const q = (url.searchParams.get("q") || "").slice(0, 100).trim();
        const category = (url.searchParams.get("category") || "").slice(0, 100).trim();
        const sortCol = { name: "filename", size: "size", date: "uploaded_at" }[url.searchParams.get("sort")] || "uploaded_at";
        const dir = url.searchParams.get("dir") === "asc" ? "ASC" : "DESC";

        const conds = [];
        const params = [];
        if (q) {
          params.push(likePattern(q), q);
          const n = params.length;
          conds.push(`(filename LIKE ?${n - 1} ESCAPE '\\' OR title LIKE ?${n - 1} ESCAPE '\\' OR id = ?${n})`);
        }
        if (category) {
          params.push(category);
          conds.push(`category = ?${params.length}`);
        }
        const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
        params.push(offset);

        // sortCol/dir come from the allowlists above — never user input
        const { results } = await env.DB.prepare(
          `SELECT id, filename, size, uploaded_at, title, category, etag FROM docs ${where} ORDER BY ${sortCol} ${dir}, id ASC LIMIT 200 OFFSET ?${params.length}`
        )
          .bind(...params)
          .all();
        const countRow = await env.DB.prepare(`SELECT COUNT(*) AS total FROM docs ${where}`)
          .bind(...params.slice(0, -1))
          .first();
        return json({ docs: results || [], total: countRow?.total || 0, offset });
      } catch (e) {
        console.error("list failed:", e);
        return json({ error: "Failed to list files" }, 500);
      }
    }

    // API: Upload
    if (path === "/api/upload" && req.method === "POST") {
      let form;
      try {
        form = await req.formData();
      } catch {
        return json({ error: "Invalid form data. Send multipart/form-data with 'file' field." }, 400);
      }

      const file = form.get("file");
      if (!file || typeof file === "string") {
        return json({ error: "No file uploaded. Field name must be 'file'." }, 400);
      }
      if (file.size === 0) return json({ error: "Empty file" }, 400);
      if (file.size > MAX_SIZE) return json({ error: `File too large. Max ${MAX_SIZE / 1024 / 1024}MB` }, 400);

      // Reject before storing if this upload would blow past the quota
      // (MAX_STORAGE_MB, default 10GB free tier). Soft cap: everything
      // uploaded before the var was set still counts toward it.
      const quota = storageQuotaBytes(env);
      if (quota > 0) {
        const usage = await usedBytes(env);
        if (usage !== null && usage + file.size > quota) {
          return json({ error: `Storage quota exceeded. ${fmtMB(quota - usage)}MB left of ${fmtMB(quota)}MB` }, 507);
        }
      }

      // Only the first 2KB is buffered (for title sniffing); the File itself
      // is handed straight to R2 below, so the worker never holds a second
      // full copy of the body in memory.
      const head = await file.slice(0, 2000).arrayBuffer();
      const titleInput = (form.get("title") || "").toString().slice(0, 200);
      const category = (form.get("category") || "").toString().slice(0, 100);
      const filename = sanitizeFilename(autoFilename(file.name || "file", titleInput, head));
      const contentType = guessContentType(filename, file.type);
      // Title keeps its spaces (shown in the dashboard); only the stored
      // filename is squished. No title → NULL, dashboard shows the filename.
      const title = titleInput.trim() || null;

      // Allocate the id by inserting FIRST — the row PK is the single source
      // of truth, so concurrent uploads can never race onto the same key
      // (the old check-then-put could delete the other upload's object on
      // rollback and leave an orphaned row).
      let id;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = nanoid();
        try {
          await env.DB.prepare(
            "INSERT INTO docs (id, filename, size, uploaded_at, title, category) VALUES (?, ?, ?, ?, ?, ?)"
          )
            .bind(candidate, filename, file.size, Date.now(), title, category || null)
            .run();
          id = candidate;
          break;
        } catch (e) {
          if (!/UNIQUE constraint failed/i.test(String(e.message || ""))) {
            console.error("insert failed:", e);
            return json({ error: "Failed to save file metadata" }, 500);
          }
          // id collision — astronomically rare, try the next candidate
        }
      }
      if (!id) return json({ error: "Failed to generate a unique id, try again" }, 500);

      const key = `p/${id}`;
      try {
        // Stream the File (a Blob) — no full copy of the body in worker memory.
        // R2's put returns an md5 of exactly what it stored — our checksum.
        const put = await env.BUCKET.put(key, file, {
          httpMetadata: { contentType },
          customMetadata: { filename, uploadedAt: String(Date.now()) },
        });
        const etag = put?.etag || null;
        // record the checksum (advisory — old rows simply have NULL)
        if (etag) {
          await env.DB.prepare("UPDATE docs SET etag = ? WHERE id = ?").bind(etag, id).run().catch(() => {});
        }
        await audit(env, "upload", id, filename, `${file.size} bytes`);
        const base = `${url.protocol}//${getSafeHost(req, url)}`;
        return json({
          id,
          filename,
          size: file.size,
          etag,
          url: `${base}/p/${id}`,
          message: "Uploaded. This URL is permanent.",
        });
      } catch (e) {
        // rollback the row so it doesn't point at a missing object
        console.error("r2 put failed:", e);
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run().catch(() => {});
        return json({ error: "Failed to store file" }, 500);
      }
    }

    // API: Delete — validate id to prevent injection
    if (path.startsWith("/api/delete/") && req.method === "DELETE") {
      const id = path.slice("/api/delete/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) return json({ error: "Invalid id" }, 400);
      let filename = null;
      try {
        const row = await env.DB.prepare("SELECT filename FROM docs WHERE id = ?").bind(id).first();
        filename = row?.filename || null;
      } catch {}
      await env.BUCKET.delete(`p/${id}`);
      await env.BUCKET.delete(`p/${id}.pdf`); // legacy cleanup
      await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();
      await audit(env, "delete", id, filename);
      return json({ ok: true, id });
    }

    // API: Rename — change the title (and category) of an existing doc.
    // The stored filename / link id stay untouched; only display metadata moves.
    if (path.startsWith("/api/rename/") && req.method === "POST") {
      const id = path.slice("/api/rename/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) return json({ error: "Invalid id" }, 400);
      let body;
      try {
        body = await req.json();
      } catch {
        return json({ error: "Invalid JSON body" }, 400);
      }
      const title = (body.title || "").toString().trim().slice(0, 200) || null;
      const category = body.category === undefined ? undefined : (body.category || "").toString().trim().slice(0, 100) || null;
      const row = await env.DB.prepare("SELECT filename, title, category FROM docs WHERE id = ?").bind(id).first();
      if (!row) return json({ error: "Not found" }, 404);
      await env.DB.prepare("UPDATE docs SET title = ?, category = COALESCE(?, category) WHERE id = ?")
        .bind(title, category ?? null, id)
        .run();
      await audit(env, "rename", id, row.filename, `title: "${row.title ?? "—"}" → "${title ?? "—"}"`);
      return json({ ok: true, id, title, category: category ?? row.category });
    }

    // API: Activity — recent audit trail for the dashboard feed.
    if (path === "/api/activity" && req.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT action, doc_id, filename, detail, ts FROM actions ORDER BY ts DESC LIMIT 50"
        ).all();
        return json({ actions: results || [] });
      } catch (e) {
        console.error("activity failed:", e);
        return json({ error: "Failed to read activity" }, 500);
      }
    }

    // API: Reconcile — the same logic the weekly cron runs, on demand.
    // Cross-checks D1 rows against R2 objects: drops rows whose object is
    // gone, migrates legacy p/<id>.pdf objects to p/<id>, reports orphans.
    if (path === "/api/reconcile" && req.method === "POST") {
      const report = await reconcile(env);
      await audit(env, "cleanup", null, null, JSON.stringify(report));
      return json({ ok: true, report });
    }

    // API: Storage — one indexed query, not a full R2 bucket scan
    // (objects placed in the bucket outside the app are not counted)
    if (path === "/api/storage" && req.method === "GET") {
      try {
        const row = await env.DB
          .prepare("SELECT COALESCE(SUM(size), 0) AS total, COUNT(*) AS count FROM docs")
          .first();
        return json({
          total: row?.total || 0,
          count: row?.count || 0,
          quota: storageQuotaBytes(env), // bytes; UI shows the bar against this
        });
      } catch (e) {
        console.error("storage failed:", e);
        return json({ error: "Failed to read storage stats" }, 500);
      }
    }

    // Fallback for unknown API routes
    if (path.startsWith("/api/")) {
      return json({ error: "Not found" }, 404);
    }

    // Static assets (Pages: _worker.js sees every request; Workers: requests
    // that didn't match an asset). env.ASSETS applies the SPA fallback.
    if (env.ASSETS) return env.ASSETS.fetch(req);
    return new Response("Not found", { status: 404 });
  },

  // Weekly cron (wrangler.toml [triggers]) — keep D1 honest against R2.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const report = await reconcile(env);
        await audit(env, "cleanup", null, null, JSON.stringify(report));
        console.log("reconcile:", JSON.stringify(report));
      })()
    );
  },
};
