#!/usr/bin/env node
// Run the ingest pipeline over a .sqlite copy (usually an extension export)
// without touching a live service — the no-refetch iteration workflow:
//
//   1. In the extension: enable capture mode, sync, Export.
//   2. Iterate on core/parse/* here:
//        node src/node/tools/ingest.ts saved-links-export.sqlite            # pending+failed rows
//        node src/node/tools/ingest.ts saved-links-export.sqlite --reingest # everything, again
//   3. Inspect results (sqlite3 CLI, tests), fix, repeat.
//
// Options:
//   --reingest         re-run every raw_data row, ingested ones included
//   --provider <id>    limit to one provider
//   --out <file>       copy the input there first, then write changes there
//   --dry-run          report what would happen against a temp copy
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDbFile } from "../node-db.ts";
import { count } from "../../core/db/items.ts";
import { rawStats } from "../../core/db/raw.ts";
import { ingestPending, reingest } from "../../core/ingest.ts";
import type { ProviderId } from "../../core/types.ts";

const args = process.argv.slice(2);
const flag = (name: string): boolean => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  return args.splice(i, 2)[1];
};

const doReingest = flag("--reingest");
const dryRun = flag("--dry-run");
const provider = opt("--provider") as ProviderId | undefined;
const out = opt("--out");
const [file] = args;

if (!file) {
  console.error(
    "usage: node src/node/tools/ingest.ts <db.sqlite> [--reingest] [--provider id] [--out file] [--dry-run]"
  );
  process.exit(1);
}

let tempDir: string | null = null;
let target = file;
if (dryRun) {
  tempDir = mkdtempSync(join(tmpdir(), "saved-links-ingest-"));
  target = join(tempDir, "dry-run.sqlite");
  copyFileSync(file, target);
} else if (out) {
  target = out;
  copyFileSync(file, target);
}

const db = openDbFile(target);
try {
  const scope = { provider: provider ?? null };
  const result = doReingest ? reingest(db, scope) : ingestPending(db, scope);

  console.log(
    `${doReingest ? "reingest" : "ingest"}: ${result.pages} pages → ` +
      `${result.ingested} ingested, ${result.failed} failed; ` +
      `saved_items: +${result.inserted} inserted, ${result.updated} updated`
  );
  for (const e of result.errors) console.log(`  failed raw_data#${e.id} (${e.provider}): ${e.error}`);

  for (const s of rawStats(db)) {
    console.log(`raw_data ${s.provider}/${s.status}: ${s.pages} pages, ${(s.bytes / 1024).toFixed(1)} KiB`);
  }
  console.log(`saved_items total: ${count(db)}`);
} finally {
  db.close();
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
}

if (dryRun) {
  console.log("(dry run — nothing written)");
} else {
  console.log(`wrote ${target}`);
}
