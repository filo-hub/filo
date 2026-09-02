-- Run: wrangler d1 execute pci-archive --file=./schema.sql
CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  uploaded_at INTEGER NOT NULL,
  title TEXT,
  category TEXT
);
CREATE INDEX IF NOT EXISTS idx_docs_uploaded ON docs(uploaded_at DESC);
