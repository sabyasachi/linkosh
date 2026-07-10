#!/usr/bin/env node
// Dump raw_data rows from a .sqlite copy into per-provider fixture files so
// a captured live page can become a checked-in parser regression test.
//
//   node src/node/tools/capture-fixtures.ts linkosh-export.sqlite [--provider id]
//     [--status failed] [--out tests/fixtures/captured]
//
// Each row becomes <out>/<provider>/<id>-<kind>.<json|html> plus a sibling
// .meta.json carrying {kind, url, context, status, error} — everything
// parsePage needs to replay it.
//
// ⚠ Bodies are dumped VERBATIM and can contain personal data (names, ids,
// session-adjacent fields). Review and scrub before committing any of it.
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDbFile } from "../node-db.ts";
import type { RawStatus } from "../../core/types.ts";

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args.splice(i, 2)[1];
};

const provider = opt("--provider");
const status = opt("--status");
const out = opt("--out") || "tests/fixtures/captured";
const [file] = args;

if (!file) {
  console.error(
    "usage: node src/node/tools/capture-fixtures.ts <db.sqlite> [--provider id] [--status pending|ingested|failed] [--out dir]"
  );
  process.exit(1);
}

interface DumpRow {
  id: number;
  provider: string;
  kind: string;
  url: string;
  page: number;
  context: string | null;
  body: string;
  fetched_at: number;
  status: RawStatus;
  error: string | null;
}

const db = openDbFile(file, { init: false, readOnly: true });
const where: string[] = [];
const bind: string[] = [];
if (provider) {
  where.push("provider = ?");
  bind.push(provider);
}
if (status) {
  where.push("status = ?");
  bind.push(status);
}
const found = db.rows<DumpRow>(
  `SELECT * FROM raw_data ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id`,
  bind
);

if (!found.length) {
  console.log("no matching raw_data rows");
  db.close();
  process.exit(0);
}

for (const row of found) {
  const dir = join(out, row.provider);
  mkdirSync(dir, { recursive: true });
  const ext = row.body.trimStart().startsWith("<") ? "html" : "json";
  const base = join(dir, `${row.id}-${row.kind}`);
  writeFileSync(`${base}.${ext}`, row.body);
  writeFileSync(
    `${base}.meta.json`,
    JSON.stringify(
      {
        provider: row.provider,
        kind: row.kind,
        url: row.url,
        page: row.page,
        context: row.context ? (JSON.parse(row.context) as unknown) : null,
        fetched_at: row.fetched_at,
        status: row.status,
        error: row.error,
      },
      null,
      2
    ) + "\n"
  );
  console.log(`${base}.${ext}`);
}
console.log(`\n${found.length} rows dumped to ${out}/ — review & scrub before committing.`);
db.close();
