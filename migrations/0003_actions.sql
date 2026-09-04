-- audit trail: every upload/delete/rename/maintenance action.
-- Best-effort only (failures are logged, never thrown).
CREATE TABLE IF NOT EXISTS actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  action TEXT NOT NULL,      -- upload | delete | rename | cleanup | migrate
  doc_id TEXT,
  filename TEXT,
  detail TEXT,
  ts INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_actions_ts ON actions(ts DESC);
