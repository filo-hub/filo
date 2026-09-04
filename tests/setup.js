// Runs once per test file, inside its isolated worker (fresh D1/R2).
// Applies ./migrations/*.sql to env.DB — same schema prod gets via
// `npm run db:migrate`. ?raw keeps this in sync with the real files.
import { env } from "cloudflare:test";
import { beforeAll } from "vitest";

import m1 from "../migrations/0001_docs.sql?raw";
import m2 from "../migrations/0002_etag.sql?raw";
import m3 from "../migrations/0003_actions.sql?raw";

const MIGRATIONS = [m1, m2, m3];

function statements(sql) {
  return sql
    .split("\n")
    .filter((line) => !line.trim().startsWith("--")) // strip comments
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);
}

beforeAll(async () => {
  for (const file of MIGRATIONS) {
    for (const stmt of statements(file)) {
      await env.DB.prepare(stmt).run();
    }
  }
});
