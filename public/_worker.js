// AUTO-GENERATED from worker.js — do not edit; regenerate with: npm run build
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

// EXIF-only build (~45KB) — just DateTimeOriginal for photo dating.
// Full exifr build would add IPTC/XMP parsing we don't use.
import exifr from "exifr/dist/lite.esm.js";

const ID_LEN = 8;
const ID_CHARS = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
const MAX_SIZE = 25 * 1024 * 1024; // self-imposed limit (CF Workers allows up to 100MB)

// content-type map by extension (fallback when the browser sends no type)
const MIME_MAP = {
  pdf: "application/pdf",
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  avif: "image/avif", bmp: "image/bmp", ico: "image/x-icon", tiff: "image/tiff", tif: "image/tiff",
  mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", mkv: "video/x-matroska",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac",
  zip: "application/zip", tar: "application/x-tar", gz: "application/gzip", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", json: "application/json", md: "text/markdown", markdown: "text/markdown",
  xml: "application/xml", yaml: "text/yaml", yml: "text/yaml",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
};

// Types the browser may render inline. SVG and HTML are deliberately excluded:
// served inline on our own origin they run script with dashboard access
// (stored XSS). Anything not listed is forced to download instead.
const INLINE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "text/csv",
  "application/json",
  "text/markdown",
]);
function isInlineType(type) {
  if (!type || typeof type !== "string") return false;
  const mime = type.split(";")[0].trim().toLowerCase();
  if (
    mime === "image/svg+xml" ||
    mime === "text/html" ||
    mime === "application/xhtml+xml" ||
    mime === "text/xml" ||
    mime === "application/xml"
  ) {
    return false;
  }
  return (
    mime.startsWith("image/") ||
    mime.startsWith("video/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("font/") ||
    INLINE_TYPES.has(mime)
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
  if (provided) {
    const mime = provided.split(";")[0].trim().toLowerCase();
    if (mime && mime !== "application/octet-stream") return mime;
  }
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

// Structured single-line JSON logs — queryable in Cloudflare Logs
// (e.g. `level = "error"`). Errors serialize to their message only;
// use fields for ids/sizes so messages stay constant and groupable.
function log(level, msg, fields = {}) {
  try {
    const out = { t: new Date().toISOString(), level, msg };
    for (const [k, v] of Object.entries(fields)) {
      out[k] = v instanceof Error ? String(v.message || v) : v;
    }
    console.log(JSON.stringify(out));
  } catch {
    try {
      console.log(`[${level}] ${msg}`);
    } catch {}
  }
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

  // Token auth
  const auth = req.headers.get("Authorization") || "";
  const got = auth.startsWith("Bearer ") ? auth.slice(7) : req.headers.get("x-upload-token") || "";
  if (await safeEqual(got, want)) return true;

  // Magic link session auth (alternative to token)
  const session = req.headers.get("Cookie") || "";
  const m = session.match(/filo_session=([A-Za-z0-9-]+)/);
  if (m) {
    const row = await env.DB.prepare("SELECT email FROM magic_links WHERE id = ? AND used = 1 AND expires_at > ?").bind(m[1], Date.now()).first();
    if (row?.email) return true;
  }
  return false;
}

// Generate a magic link for the given email address. Returns the login URL.
async function generateMagicLink(env, email, origin) {
  const id = nanoid(16);
  const expiresAt = Date.now() + 24 * 60 * 60 * 1000; // 24h
  await env.DB.prepare("INSERT INTO magic_links (id, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
    .bind(id, email, expiresAt, Date.now())
    .run();
  return `${origin}/api/login/${id}`;
}

// Verify a magic link token and return the email (or null if invalid/expired)
// Atomic consume: the UPDATE only matches unused, unexpired rows, so two
// concurrent GETs can't both redeem the same link (old SELECT-then-UPDATE
// had a replay race). Returns null on any failure — no reason oracle.
async function verifyMagicLink(env, id) {
  try {
    const upd = await env.DB.prepare(
      "UPDATE magic_links SET used = 1 WHERE id = ? AND used = 0 AND expires_at > ?"
    ).bind(id, Date.now()).run();
    if (!upd.meta?.changes) return null;
    const row = await env.DB.prepare("SELECT email FROM magic_links WHERE id = ?").bind(id).first();
    return row?.email || null;
  } catch {
    return null;
  }
}

// Optional email allowlist for /api/request-link. Set ALLOWED_EMAILS to a
// comma-separated list; when set, only those addresses can mint links.
// Unset (default) preserves the old open behavior for single-user setups.
function emailAllowed(env, email) {
  const raw = (env.ALLOWED_EMAILS || "").trim();
  if (!raw) return true;
  const allowed = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return allowed.includes(email.toLowerCase());
}

// Best-effort prune of expired links (table would otherwise grow forever).
// Runs inside request-link; failures are swallowed by design.
async function pruneMagicLinks(env) {
  try {
    await env.DB.prepare("DELETE FROM magic_links WHERE expires_at < ?").bind(Date.now()).run();
  } catch {}
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
    log("error", "audit write failed", { error: e });
  }
}

// LIKE pattern for search: % wildcards, but the user's own % and _ are
// escaped so a query of "50%" doesn't match everything.
function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (c) => "\\" + c)}%`;
}


function sanitizeFilename(filename) {
  // Strip path, control chars, quotes, backslashes; limit length; fallback to "file"
  let s = String(filename || "").split("/").pop().split("\\").pop();
  s = s.replace(/[\r\n"\\;]/g, "").replace(/[\x00-\x1f\x7f]/g, "").trim();
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

// ---- content-based naming -------------------------------------------------
// Priority: typed title > embedded document title (PDF) > original filename
// > sniffed text (txt/csv/...) > "file". Photos keep the shoot date for the
// DDMMYYYY part instead of the upload date. Anything opaque (zip, video,
// audio, office blobs we can't parse cheaply) falls back to the original
// name — which is the user's own label for it.
const IMAGE_EXTS = new Set(["jpg", "jpeg", "heic", "heif", "png", "webp", "tif", "tiff"]);
const EXIF_HEAD_BYTES = 256 * 1024; // EXIF lives at the start of the file
const PDF_HEAD_BYTES = 64 * 1024; // linearized PDFs stash /Info up front
const PDF_TAIL_BYTES = 256 * 1024; // ...but the trailer is usually at the end

// Only formats that can actually carry EXIF reach the parser: the exifr
// lite build knows JPEG/HEIC/AVIF/TIFF, and anything else makes it reject
// with "Unknown file format" on a detached promise try/catch can't see.
// PNG is deliberately excluded — screenshots essentially never carry EXIF.
function looksExifCapable(buf) {
  const b = new Uint8Array(buf);
  if (b.length < 12) return false;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true; // JPEG SOI
  if (b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2a && b[3] === 0x00) return true; // TIFF LE
  if (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0x00 && b[3] === 0x2a) return true; // TIFF BE
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return true; // ftyp (HEIC/AVIF)
  return false;
}

// EXIF shoot date (or null). Pure JS, no native deps — safe in workers.
// Notes: no `pick` option (that path throws in exifr lite); the lite build
// returns numeric tag keys, so read 36867/36868 as well as the translated
// names. EXIF dates are "YYYY:MM:DD HH:MM:SS" strings — parsed manually.
async function sniffPhotoTakenAt(buf) {
  if (!looksExifCapable(buf)) return null;
  try {
    const tags = await exifr.parse(buf);
    if (!tags) return null;
    const raw = tags.DateTimeOriginal || tags.CreateDate || tags["36867"] || tags["36868"];
    if (raw instanceof Date && !isNaN(raw)) return raw;
    if (typeof raw === "string") {
      const m = raw.match(/(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
      if (m) {
        const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
        if (!isNaN(d)) return d;
      }
    }
  } catch {}
  return null;
}

function unescapePdfString(s) {
  return s.replace(/\\([nrtbf()\\])/g, (m, c) => ({ n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", "(": "(", ")": ")", "\\": "\\" }[c] ?? c));
}

// PDF document title from /Info, without a full PDF parser: scan the head
// (linearized) + tail (trailer) slices for /Title. Handles both literal
// "(...)" strings (with \( \) \\ escapes) and <hex> (UTF-16BE BOM or latin1).
function sniffPdfTitle(headBuf, tailBuf) {
  try {
    const text = new TextDecoder("latin1").decode(headBuf) + "\n" + new TextDecoder("latin1").decode(tailBuf);
    let m = text.match(/\/Title\s*\(((?:\\.|[^\\()])*)\)/);
    if (m && m[1].trim()) return unescapePdfString(m[1]).trim();
    m = text.match(/\/Title\s*<([0-9A-Fa-f\s]+)>/);
    if (m) {
      const hex = m[1].replace(/\s+/g, "");
      if (hex.length >= 2 && hex.length % 2 === 0) {
        const bytes = new Uint8Array(hex.match(/../g).map((h) => parseInt(h, 16)));
        const s =
          bytes[0] === 0xfe && bytes[1] === 0xff
            ? new TextDecoder("utf-16be").decode(bytes.subarray(2))
            : new TextDecoder("latin1").decode(bytes);
        if (s.trim()) return s.trim();
      }
    }
  } catch {}
  return null;
}

function autoFilename({ titleInput, originalName, textBuf, pdfTitle, photoDate }) {
  let base = (titleInput || "").trim() || pdfTitle || "";
  if (!base) {
    const orig = (originalName || "").replace(/\.[^/.]+$/, "").trim();
    if (orig && orig !== "file" && orig !== "blob") {
      base = orig;
    }
  }
  if (!base && textBuf) {
    try {
      const text = new TextDecoder().decode(textBuf.slice(0, 2000));
      // look for first meaningful line (alphanumeric). Slice wide here —
      // whitespace is stripped below, so slicing tight would eat real chars
      // (e.g. "Shopping List" must survive as "ShoppingLi", not "ShoppingL").
      const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => /[A-Za-z0-9]{3,}/.test(l));
      if (lines[0]) base = lines[0].slice(0, 40);
    } catch {}
  }
  if (!base) {
    base = (originalName || "file").replace(/\.[^/.]+$/, "") || "file";
  }
  base = base.replace(/\s+/g, "").replace(/[^A-Za-z0-9._-]/g, "").slice(0, 10) || "file";
  const ext = extOf(originalName) || "bin";
  const d = photoDate instanceof Date && !isNaN(photoDate) ? photoDate : new Date();
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
    log("error", "reconcile list failed", { error: e });
    return report;
  }
  const rowIdSet = new Set();
  for (const row of rows || []) {
    rowIdSet.add(row.id);
    report.checked++;
    let obj = null;
    try {
      obj = await env.BUCKET.head(`p/${row.id}`);
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
      log("error", "reconcile head failed", { id: row.id, error: e });
      continue;
    }
    if (!obj) {
      // no object anywhere — the row is a dead link
      try {
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(row.id).run();
        report.droppedRows++;
      } catch (e) {
        report.errors++;
        log("error", "reconcile drop row failed", { id: row.id, error: e });
      }
    }
  }

  // Scan R2 for orphans (objects in bucket with no D1 row)
  try {
    let truncated = true;
    let cursor = undefined;
    while (truncated && report.orphans.length < 50) {
      const list = await env.BUCKET.list({ prefix: "p/", cursor, limit: 200 });
      for (const item of list.objects || []) {
        const rawId = item.key.slice(2).replace(/\.pdf$/, "");
        if (!rowIdSet.has(rawId)) {
          report.orphans.push(item.key);
          if (report.orphans.length >= 50) break;
        }
      }
      truncated = list.truncated;
      cursor = list.cursor;
    }
  } catch (e) {
    report.errors++;
    log("error", "reconcile bucket list failed", { error: e });
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

      const isHead = req.method === "HEAD";
      const range = req.headers.get("Range");

      // For HEAD or Range requests, fetch metadata first via head()
      // to prevent downloading full object bodies unnecessarily.
      // R2 outage → 503 (retryable), never an unhandled rejection.
      let obj;
      let key = `p/${id}`;
      try {
        if (isHead || range) {
          obj = await env.BUCKET.head(`p/${id}`);
          if (!obj) {
            obj = await env.BUCKET.head(`p/${id}.pdf`);
            key = `p/${id}.pdf`;
          }
        } else {
          obj = await env.BUCKET.get(`p/${id}`);
          if (!obj) {
            obj = await env.BUCKET.get(`p/${id}.pdf`);
            key = `p/${id}.pdf`;
          }
        }
      } catch (e) {
        log("error", "serve R2 failed", { id, error: e });
        return new Response("Storage unavailable, try again", { status: 503 });
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

      if (range) {
        // Single range only: "bytes=a-b", "bytes=a-", or suffix "bytes=-n"
        const m = range.match(/^bytes=(\d*)-(\d*)$/);
        if (m && (m[1] || m[2])) {
          let start, end;
          if (!m[1]) {
            // suffix range: last n bytes
            const n = parseInt(m[2], 10);
            if (n === 0 || obj.size === 0) {
              headers.set("Content-Range", `bytes */${obj.size}`);
              return new Response("Range Not Satisfiable", { status: 416, headers });
            }
            start = Math.max(0, obj.size - n);
            end = obj.size - 1;
          } else {
            start = parseInt(m[1], 10);
            end = m[2] ? parseInt(m[2], 10) : obj.size - 1;
          }
          // Validate range
          if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= obj.size) {
            headers.set("Content-Range", `bytes */${obj.size}`);
            return new Response("Range Not Satisfiable", { status: 416, headers });
          }
          // Clamp end to obj.size - 1 per RFC 9110
          if (end >= obj.size) end = obj.size - 1;

          const sliced = await env.BUCKET.get(key, { range: { offset: start, length: end - start + 1 } });
          if (sliced) {
            headers.set("Content-Range", `bytes ${start}-${end}/${obj.size}`);
            headers.set("Content-Length", String(end - start + 1));
            if (isHead) {
              return new Response(null, { status: 206, headers });
            }
            return new Response(sliced.body, { status: 206, headers });
          }
        }
      }

      headers.set("Content-Length", String(obj.size));
      if (isHead) {
        return new Response(null, { headers });
      }
      if (obj.body) {
        return new Response(obj.body, { headers });
      }
      const full = await env.BUCKET.get(key);
      if (full?.body) {
        return new Response(full.body, { headers });
      }
      return new Response("Not found", { status: 404, headers });
    }

    // API: Health — public (uptime checks). `auth` lets the dashboard show
    // its open-mode warning banner without an authenticated round-trip.
    // When Cloudflare Access is enabled, also reports the authenticated user.
    if (path === "/api/health") {
      // Public by design (uptime checks). Reports only whether auth is
      // enforced — never *who* is authenticated (no emails here; the
      // session cookie is validated but its identity stays server-side).
      const accessAuth = req.headers.get("cf-access-authenticated") === "true";
      let magicAuthed = false;
      const cookie = req.headers.get("Cookie") || "";
      const m = cookie.match(/filo_session=([A-Za-z0-9-]+)/);
      if (m) {
        const row = await env.DB.prepare("SELECT id FROM magic_links WHERE id = ? AND used = 1 AND expires_at > ?").bind(m[1], Date.now()).first();
        magicAuthed = !!row;
      }
      return json({ ok: true, time: Date.now(), auth: Boolean(env.UPLOAD_TOKEN) || accessAuth || magicAuthed });
    }

    // API: Request a magic link — POST /api/request-link
    // Body: { email: "user@example.com" }
    if (path === "/api/request-link" && req.method === "POST") {
      let body;
      try { body = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
        return json({ error: "A valid email address is required" }, 400);
      }
      if (!emailAllowed(env, email)) {
        return json({ error: "Email not allowed" }, 403);
      }
      await pruneMagicLinks(env);
      const id = nanoid(16);
      const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
      try {
        await env.DB.prepare("INSERT INTO magic_links (id, email, expires_at, used, created_at) VALUES (?, ?, ?, 0, ?)")
          .bind(id, email, expiresAt, Date.now())
          .run();
      } catch (e) {
        log("error", "magic link insert failed", { error: e });
        return json({ error: "Could not create login link" }, 500);
      }
      const origin = `${url.protocol}//${url.host}`;
      const link = `${origin}/api/login/${id}`;
      // Returned in-band (there's no SMTP wired up); NOT logged — workers
      // logs are persistent and the link is a live credential.
      return json({ ok: true, link, email, expires_in: 24 * 3600 });
    }

    // API: Verify a magic link — GET /api/login/:id
    // Sets a session cookie and redirects to the dashboard
    if (path.startsWith("/api/login/") && req.method === "GET") {
      const id = path.slice("/api/login/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{16}$/.test(id)) {
        return new Response("Invalid link", { status: 400 });
      }
      const email = await verifyMagicLink(env, id);
      if (!email) {
        return new Response("Invalid or expired login link", { status: 400 });
      }
      const headers = new Headers();
      headers.set("Set-Cookie", `filo_session=${id}; HttpOnly; Secure; SameSite=Strict; Max-Age=${24 * 3600}; Path=/`);
      headers.set("Location", "/");
      return new Response(null, { status: 302, headers });
    }

    // Private API — token-gated when UPLOAD_TOKEN is set. Scoped to /api/*
    // only: /p/* links and the static frontend below stay public. (The
    // public endpoints above — health, request-link, login — return early.)
    if (path.startsWith("/api/") && !(await authorized(req, env))) {
      return json({ error: "Unauthorized" }, 401);
    }

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
        log("error", "list failed", { error: e });
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

      // Content sniffing by type (slices only — the File itself is handed
      // straight to R2 below, so the worker never holds a second full copy
      // of the body in memory):
      //   text-likes → first 2KB, first meaningful line
      //   pdf       → /Title from head + tail slices (trailer lives at end)
      //   images    → EXIF shoot date (used for DDMMYYYY, not upload date)
      //   anything else (zip, video, audio, …) → original filename as-is
      const ext = extOf(file.name || "");
      const head = await file.slice(0, 2000).arrayBuffer();
      let pdfTitle = null;
      let photoDate = null;
      try {
        if (ext === "pdf") {
          const h = await file.slice(0, PDF_HEAD_BYTES).arrayBuffer();
          const tailStart = Math.max(0, file.size - PDF_TAIL_BYTES);
          const t = tailStart > 0 ? await file.slice(tailStart).arrayBuffer() : h;
          pdfTitle = sniffPdfTitle(h, t);
        } else if (IMAGE_EXTS.has(ext)) {
          const imgHead = await file.slice(0, Math.min(file.size, EXIF_HEAD_BYTES)).arrayBuffer();
          photoDate = await sniffPhotoTakenAt(imgHead);
        }
      } catch {}
      const titleInput = (form.get("title") || "").toString().slice(0, 200);
      const category = (form.get("category") || "").toString().slice(0, 100);
      const filename = sanitizeFilename(
        autoFilename({ titleInput, originalName: file.name || "file", textBuf: head, pdfTitle, photoDate })
      );
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
            log("error", "insert failed", { error: e });
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
        // fire-and-forget: audit must never add tail latency to uploads
        ctx.waitUntil(audit(env, "upload", id, filename, `${file.size} bytes`));
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
        log("error", "r2 put failed", { error: e });
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run().catch(() => {});
        return json({ error: "Failed to store file" }, 500);
      }
    }

    // API: Delete — validate id to prevent injection.
    // Best-effort on both R2 keys (legacy second): a failed object delete
    // must not stop the row delete, and vice versa — reconcile converges
    // whatever is left (orphan objects are reported, never auto-deleted).
    if (path.startsWith("/api/delete/") && req.method === "DELETE") {
      const id = path.slice("/api/delete/".length).split("/")[0];
      if (!id || !/^[A-Za-z0-9]{6,12}$/.test(id)) return json({ error: "Invalid id" }, 400);
      let filename = null;
      try {
        const row = await env.DB.prepare("SELECT filename FROM docs WHERE id = ?").bind(id).first();
        filename = row?.filename || null;
      } catch {}
      const errs = [];
      for (const k of [`p/${id}`, `p/${id}.pdf`]) {
        try {
          await env.BUCKET.delete(k);
        } catch (e) {
          errs.push(k);
          log("error", "delete R2 failed", { id, key: k, error: e });
        }
      }
      try {
        await env.DB.prepare("DELETE FROM docs WHERE id = ?").bind(id).run();
      } catch (e) {
        log("error", "delete D1 failed", { id, error: e });
        return json({ error: "Delete failed, try again" }, 500);
      }
      ctx.waitUntil(audit(env, "delete", id, filename));
      if (errs.length) return json({ ok: true, id, warnings: errs.map((k) => `object ${k} may remain`) });
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
      let row;
      try {
        row = await env.DB.prepare("SELECT filename, title, category FROM docs WHERE id = ?").bind(id).first();
      } catch (e) {
        log("error", "rename lookup failed", { id, error: e });
        return json({ error: "Rename failed, try again" }, 500);
      }
      if (!row) return json({ error: "Not found" }, 404);
      const newCategory =
        body.category !== undefined
          ? (body.category || "").toString().trim().slice(0, 100) || null
          : row.category;
      try {
        await env.DB.prepare("UPDATE docs SET title = ?, category = ? WHERE id = ?")
          .bind(title, newCategory, id)
          .run();
      } catch (e) {
        log("error", "rename update failed", { id, error: e });
        return json({ error: "Rename failed, try again" }, 500);
      }
      ctx.waitUntil(audit(env, "rename", id, row.filename, `title: "${row.title ?? "—"}" → "${title ?? "—"}"`));
      return json({ ok: true, id, title, category: newCategory });
    }

    // API: Activity — recent audit trail for the dashboard feed.
    if (path === "/api/activity" && req.method === "GET") {
      try {
        const { results } = await env.DB.prepare(
          "SELECT action, doc_id, filename, detail, ts FROM actions ORDER BY ts DESC LIMIT 50"
        ).all();
        return json({ actions: results || [] });
      } catch (e) {
        log("error", "activity failed", { error: e });
        return json({ error: "Failed to read activity" }, 500);
      }
    }

    // API: Reconcile — the same logic the weekly cron runs, on demand.
    // Cross-checks D1 rows against R2 objects: drops rows whose object is
    // gone, migrates legacy p/<id>.pdf objects to p/<id>, reports orphans.
    if (path === "/api/reconcile" && req.method === "POST") {
      const report = await reconcile(env);
      ctx.waitUntil(audit(env, "cleanup", null, null, JSON.stringify(report)));
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
        log("error", "storage failed", { error: e });
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
  // Belt-and-braces .catch: reconcile()/audit() guard internally, but a
  // rejected waitUntil would mark the whole cron run failed in logs.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const report = await reconcile(env);
        await audit(env, "cleanup", null, null, JSON.stringify(report));
        log("info", "reconcile finished", { report });
      })().catch((e) => log("error", "scheduled reconcile failed", { error: e }))
    );
  },
};
