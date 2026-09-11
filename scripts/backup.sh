#!/usr/bin/env bash
# Weekly backup: D1 dump + R2 object mirror into the filo-backup bucket.
# - D1 dump rotates by day-of-month (d1-01.sql … d1-31.sql): ~31 versions,
#   self-rotating, no listing needed.
# - R2 objects mirror by id (r2/p/<id>); overwrites track current versions.
#   Deleted files linger in the backup — that is the point (accidental
#   deletes are recoverable). Prune filo-backup manually if it grows.
# - The D1 docs table is the inventory (reconcile guarantees every live
#   object has a row), so no bucket-listing primitive is needed.
# Usage: npm run backup  (needs CLOUDFLARE_API_TOKEN + ACCOUNT_ID in env)
set -euo pipefail

DAY=$(date +%d)
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "== D1 export =="
npx wrangler d1 export filo-db --remote --output "$TMPDIR/d1.sql"
npx wrangler r2 object put "filo-backup/d1-$DAY.sql" --file "$TMPDIR/d1.sql" --remote
echo "dump stored as filo-backup/d1-$DAY.sql"

echo "== R2 mirror =="
IDS=$(npx wrangler d1 execute filo-db --remote --json --command "SELECT id FROM docs" \
  | python3 -c "import json,sys; print('\n'.join(r['id'] for r in json.load(sys.stdin)[0]['results']))")
COUNT=0
for id in $IDS; do
  npx wrangler r2 object get "filo-files/p/$id" --file "$TMPDIR/obj" --remote >/dev/null
  npx wrangler r2 object put "filo-backup/r2/p/$id" --file "$TMPDIR/obj" --remote >/dev/null
  COUNT=$((COUNT + 1))
done
echo "mirrored $COUNT object(s) to filo-backup/r2/"
echo "backup complete"
