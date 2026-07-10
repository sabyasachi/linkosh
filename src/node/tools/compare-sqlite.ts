#!/usr/bin/env node
// Compare two SQLite database files logically.
//
// Examples:
//   node src/node/tools/compare-sqlite.ts before.sqlite after.sqlite
//   node src/node/tools/compare-sqlite.ts before.sqlite after.sqlite \
//     --table saved_items --key saved_items=provider,account,external_id
//
// The first database is opened as main; the second is attached as rhs. The
// script compares every non-sqlite_* table present in the first DB unless
// --table is passed. It exits nonzero when a schema or data difference is found.
import { existsSync } from "node:fs";
import { openDbFile } from "../node-db.ts";
import type { SqlDatabase } from "../../core/db/port.ts";

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface IndexInfo {
  name: string;
  unique: number;
  partial: number;
}

interface IndexColumnInfo {
  name: string;
  seqno: number;
}

interface CountRow {
  count: number | null;
}

interface TableResult {
  table: string;
  beforeRows: number | null;
  afterRows: number | null;
  missingTable: boolean;
  schemaChanged: boolean;
  beforeOnlyRows: number | null;
  afterOnlyRows: number | null;
  key: string[] | null;
  duplicateBeforeKeys: number | null;
  duplicateAfterKeys: number | null;
  missingByKey: number | null;
  newByKey: number | null;
  changedRowsByKey: number | null;
  changedCellsByColumn: Map<string, number>;
}

const args = process.argv.slice(2);

const takeAll = (name: string): string[] => {
  const values: string[] = [];
  for (;;) {
    const i = args.indexOf(name);
    if (i === -1) return values;
    const value = args[i + 1];
    if (!value || value.startsWith("--")) usage(`missing value for ${name}`);
    values.push(value);
    args.splice(i, 2);
  }
};

const tables = takeAll("--table");
const keyArgs = takeAll("--key");
const [beforeFile, afterFile, ...rest] = args;

if (rest.length || !beforeFile || !afterFile) usage();
if (!existsSync(beforeFile)) usage(`not found: ${beforeFile}`);
if (!existsSync(afterFile)) usage(`not found: ${afterFile}`);

const explicitKeys = new Map<string, string[]>();
for (const keyArg of keyArgs) {
  const [table, columns] = keyArg.split("=", 2);
  if (!table || !columns) usage(`invalid --key ${keyArg}; expected table=col,col`);
  const key = columns
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!key.length) usage(`invalid --key ${keyArg}; no columns`);
  explicitKeys.set(table, key);
}

const db = openDbFile(beforeFile, { init: false, readOnly: true });
let hadDiff = false;

try {
  db.run("ATTACH DATABASE ? AS rhs", [afterFile]);

  const tableNames = tables.length ? tables : listTables(db, "main");
  const rhsTables = new Set(listTables(db, "rhs"));

  console.log(`Comparing ${beforeFile}`);
  console.log(`Against   ${afterFile}`);
  console.log("");

  for (const table of tableNames) {
    const result = compareTable(db, table, rhsTables.has(table), explicitKeys.get(table) ?? null);
    printResult(result);
    if (
      result.missingTable ||
      result.schemaChanged ||
      (result.beforeOnlyRows ?? 0) > 0 ||
      (result.afterOnlyRows ?? 0) > 0 ||
      (result.missingByKey ?? 0) > 0 ||
      (result.newByKey ?? 0) > 0 ||
      (result.changedRowsByKey ?? 0) > 0
    ) {
      hadDiff = true;
    }
  }
} finally {
  db.close();
}

process.exitCode = hadDiff ? 1 : 0;

function usage(error?: string): never {
  if (error) console.error(error);
  console.error(
    "usage: node src/node/tools/compare-sqlite.ts <before.sqlite> <after.sqlite> " +
      "[--table name] [--key table=col,col]"
  );
  process.exit(2);
}

function listTables(db: SqlDatabase, schema: "main" | "rhs"): string[] {
  return db
    .rows<{ name: string }>(
      `SELECT name
       FROM ${quoteIdent(schema)}.sqlite_schema
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
       ORDER BY name`
    )
    .map((row) => row.name);
}

function compareTable(
  db: SqlDatabase,
  table: string,
  rhsTableExists: boolean,
  explicitKey: string[] | null
): TableResult {
  const beforeColumns = tableInfo(db, "main", table);
  const beforeRows = countRows(db, "main", table);
  const empty: TableResult = {
    table,
    beforeRows,
    afterRows: null,
    missingTable: !rhsTableExists,
    schemaChanged: false,
    beforeOnlyRows: null,
    afterOnlyRows: null,
    key: null,
    duplicateBeforeKeys: null,
    duplicateAfterKeys: null,
    missingByKey: null,
    newByKey: null,
    changedRowsByKey: null,
    changedCellsByColumn: new Map(),
  };
  if (!rhsTableExists) return empty;

  const afterColumns = tableInfo(db, "rhs", table);
  const beforeNames = beforeColumns.map((column) => column.name);
  const afterNames = afterColumns.map((column) => column.name);
  const commonColumns = beforeNames.filter((name) => afterNames.includes(name));
  const schemaChanged = JSON.stringify(beforeColumns) !== JSON.stringify(afterColumns);
  const columnsSql = commonColumns.map(quoteIdent).join(", ");
  const afterRows = countRows(db, "rhs", table);

  const beforeOnlyRows = columnsSql
    ? countGroupedRowsExcept(db, "main", "rhs", table, columnsSql)
    : beforeRows === afterRows
      ? 0
      : beforeRows;
  const afterOnlyRows = columnsSql
    ? countGroupedRowsExcept(db, "rhs", "main", table, columnsSql)
    : beforeRows === afterRows
      ? 0
      : afterRows;

  const key = pickKey(db, table, beforeColumns, afterNames, explicitKey);
  const result: TableResult = {
    ...empty,
    afterRows,
    schemaChanged,
    beforeOnlyRows,
    afterOnlyRows,
    key,
  };

  if (!key) return result;

  result.duplicateBeforeKeys = duplicateKeys(db, "main", table, key);
  result.duplicateAfterKeys = duplicateKeys(db, "rhs", table, key);
  result.missingByKey = rowsMissingByKey(db, "main", "rhs", table, key);
  result.newByKey = rowsMissingByKey(db, "rhs", "main", table, key);

  const comparedColumns = commonColumns.filter((column) => !key.includes(column));
  if (!comparedColumns.length) {
    result.changedRowsByKey = 0;
    return result;
  }

  const joinSql = key.map((column) => `r.${quoteIdent(column)} IS l.${quoteIdent(column)}`).join(" AND ");
  const changedPredicate = comparedColumns
    .map((column) => `r.${quoteIdent(column)} IS NOT l.${quoteIdent(column)}`)
    .join(" OR ");
  result.changedRowsByKey = scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM ${qTable("main", table)} AS l
     JOIN ${qTable("rhs", table)} AS r ON ${joinSql}
     WHERE ${changedPredicate}`
  );

  const diffSelect = comparedColumns
    .map(
      (column) =>
        `SUM(CASE WHEN r.${quoteIdent(column)} IS NOT l.${quoteIdent(column)} THEN 1 ELSE 0 END) AS ${quoteIdent(
          column
        )}`
    )
    .join(", ");
  const [diffs] = db.rows<Record<string, number | null>>(
    `SELECT ${diffSelect}
     FROM ${qTable("main", table)} AS l
     JOIN ${qTable("rhs", table)} AS r ON ${joinSql}`
  );
  for (const [column, count] of Object.entries(diffs ?? {})) {
    if (count) result.changedCellsByColumn.set(column, count);
  }

  return result;
}

function printResult(result: TableResult): void {
  console.log(result.table);
  if (result.missingTable) {
    console.log(`  missing table in after DB; before rows: ${result.beforeRows}`);
    console.log("");
    return;
  }

  console.log(`  rows: before=${result.beforeRows} after=${result.afterRows}`);
  console.log(`  schema: ${result.schemaChanged ? "changed" : "same"}`);
  console.log(
    `  full-row multiset diff: before-only=${result.beforeOnlyRows} after-only=${result.afterOnlyRows}`
  );

  if (!result.key) {
    console.log("  cell diff by key: skipped; no primary/unique key inferred");
    console.log("");
    return;
  }

  console.log(`  key: ${result.key.join(",")}`);
  console.log(
    `  key diff: before-missing-in-after=${result.missingByKey} after-only=${result.newByKey} ` +
      `duplicate-before-keys=${result.duplicateBeforeKeys} duplicate-after-keys=${result.duplicateAfterKeys}`
  );
  console.log(`  changed rows by key: ${result.changedRowsByKey}`);
  if (result.changedCellsByColumn.size) {
    console.log("  changed cells by column:");
    for (const [column, count] of result.changedCellsByColumn) console.log(`    ${column}: ${count}`);
  } else {
    console.log("  changed cells by column: none");
  }
  console.log("");
}

function tableInfo(db: SqlDatabase, schema: "main" | "rhs", table: string): ColumnInfo[] {
  return db.rows<ColumnInfo>(`PRAGMA ${quoteIdent(schema)}.table_info(${quoteIdent(table)})`);
}

function countRows(db: SqlDatabase, schema: "main" | "rhs", table: string): number {
  return scalarCount(db, `SELECT COUNT(*) AS count FROM ${qTable(schema, table)}`);
}

function countGroupedRowsExcept(
  db: SqlDatabase,
  lhsSchema: "main" | "rhs",
  rhsSchema: "main" | "rhs",
  table: string,
  columnsSql: string
): number {
  return scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM (
       SELECT ${columnsSql}, COUNT(*) AS __row_count
       FROM ${qTable(lhsSchema, table)}
       GROUP BY ${columnsSql}
       EXCEPT
       SELECT ${columnsSql}, COUNT(*) AS __row_count
       FROM ${qTable(rhsSchema, table)}
       GROUP BY ${columnsSql}
     )`
  );
}

function pickKey(
  db: SqlDatabase,
  table: string,
  beforeColumns: ColumnInfo[],
  afterNames: string[],
  explicitKey: string[] | null
): string[] | null {
  if (explicitKey) {
    const beforeNames = new Set(beforeColumns.map((column) => column.name));
    for (const column of explicitKey) {
      if (!beforeNames.has(column)) usage(`--key ${table}: before table has no column ${column}`);
      if (!afterNames.includes(column)) usage(`--key ${table}: after table has no column ${column}`);
    }
    return explicitKey;
  }

  const primaryKey = beforeColumns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name)
    .filter((name) => afterNames.includes(name));
  if (primaryKey.length) return primaryKey;

  const indexes = db
    .rows<IndexInfo>(`PRAGMA main.index_list(${quoteIdent(table)})`)
    .filter((index) => index.unique && !index.partial)
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const index of indexes) {
    const columns = db
      .rows<IndexColumnInfo>(`PRAGMA main.index_info(${quoteIdent(index.name)})`)
      .sort((a, b) => a.seqno - b.seqno)
      .map((column) => column.name)
      .filter(Boolean);
    if (columns.length && columns.every((column) => afterNames.includes(column))) return columns;
  }

  return null;
}

function duplicateKeys(db: SqlDatabase, schema: "main" | "rhs", table: string, key: string[]): number {
  const keySql = key.map(quoteIdent).join(", ");
  return scalarCount(
    db,
    `SELECT COALESCE(SUM(c - 1), 0) AS count
     FROM (
       SELECT ${keySql}, COUNT(*) AS c
       FROM ${qTable(schema, table)}
       GROUP BY ${keySql}
       HAVING COUNT(*) > 1
     )`
  );
}

function rowsMissingByKey(
  db: SqlDatabase,
  lhsSchema: "main" | "rhs",
  rhsSchema: "main" | "rhs",
  table: string,
  key: string[]
): number {
  const predicate = key.map((column) => `r.${quoteIdent(column)} IS l.${quoteIdent(column)}`).join(" AND ");
  return scalarCount(
    db,
    `SELECT COUNT(*) AS count
     FROM ${qTable(lhsSchema, table)} AS l
     WHERE NOT EXISTS (
       SELECT 1
       FROM ${qTable(rhsSchema, table)} AS r
       WHERE ${predicate}
     )`
  );
}

function scalarCount(db: SqlDatabase, sql: string): number {
  const [row] = db.rows<CountRow>(sql);
  return row?.count ?? 0;
}

function qTable(schema: "main" | "rhs", table: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`;
}

function quoteIdent(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}
