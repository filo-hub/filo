-- md5 checksum straight from R2 (httpEtag) — stored per file so the
-- dashboard can prove a download is byte-identical to what was uploaded.
ALTER TABLE docs ADD COLUMN etag TEXT;
