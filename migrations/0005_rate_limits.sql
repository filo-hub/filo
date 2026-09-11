-- Fixed-window throttles for abuse-prone endpoints (upload, request-link,
-- login). Keyed by scope, e.g. "upload:1.2.3.4". Old windows are pruned
-- opportunistically by the worker; this table stays tiny by design.
CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
