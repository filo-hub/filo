-- Moved to ./migrations/ (wrangler d1 migrations apply). Kept as a pointer
-- so old READMEs / muscle memory don't silently drift the schema.
--
--   npm run db:migrate            (local)
--   npm run db:migrate:remote      (production)
--
-- 0001 docs baseline · 0002 etag checksums · 0003 actions audit log
SELECT 'schema.sql is a stub — use migrations/, see package.json' AS notice;
