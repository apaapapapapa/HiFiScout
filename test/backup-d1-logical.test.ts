import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import {
  buildRowidDumpQuery,
  buildWithoutRowidDumpQuery,
  quoteIdentifier,
  selectBackupTables,
} from "../scripts/backup-d1-logical.js";

const backupWorkflow = readFileSync(
  new URL("../.github/workflows/backup.yml", import.meta.url),
  "utf8",
);

test("logical D1 backup excludes FTS virtual/shadow and provider-owned tables", () => {
  const tables = selectBackupTables([
    { schema: "main", name: "products", type: "table", wr: 0 },
    { schema: "main", name: "products_fts", type: "virtual", wr: 0 },
    { schema: "main", name: "products_fts_data", type: "shadow", wr: 0 },
    { schema: "main", name: "sqlite_sequence", type: "table", wr: 0 },
    { schema: "main", name: "_cf_METADATA", type: "table", wr: 0 },
    { schema: "main", name: "d1_migrations", type: "table", wr: 0 },
    { schema: "temp", name: "temporary_rows", type: "table", wr: 0 },
    { schema: "main", name: "settings", type: "table", wr: 1 },
  ]);

  assert.deepEqual(tables, [
    { name: "products", withoutRowid: false },
    { name: "settings", withoutRowid: true },
  ]);
});

test("rowid backup SQL uses server-side quote() and a fixed upper boundary", () => {
  const query = buildRowidDumpQuery(
    'odd"table',
    [
      { name: "id", hidden: 0, pk: 1 },
      { name: "payload", hidden: 0, pk: 0 },
    ],
    "9007199254740993",
    "17",
    500,
  );

  assert.match(query, /INSERT OR REPLACE INTO "odd""table"/u);
  assert.match(query, /quote\("id"\)/u);
  assert.match(query, /quote\("payload"\)/u);
  assert.match(query, /rowid <= 9007199254740993 AND rowid > 17/u);
  assert.match(query, /ORDER BY rowid LIMIT 500/u);
  assert.equal(quoteIdentifier('a"b'), '"a""b"');
});

test("WITHOUT ROWID backup advances by its ordered primary-key tuple", () => {
  const columns = [
    { name: "shop_key", hidden: 0, pk: 1 },
    { name: "source_id", hidden: 0, pk: 2 },
    { name: "value", hidden: 0, pk: 0 },
  ];
  const query = buildWithoutRowidDumpQuery(
    "listing_state",
    columns,
    columns.filter((column) => column.pk > 0),
    ["'audio-union'", "'00123'"],
    250,
  );

  assert.match(query, /"shop_key" > 'audio-union'/u);
  assert.match(query, /"shop_key" = 'audio-union' AND "source_id" > '00123'/u);
  assert.match(query, /ORDER BY "shop_key", "source_id" LIMIT 250/u);
});

test("Backup D1 workflow uses the FTS-safe logical exporter and validates its artifact", () => {
  assert.match(backupWorkflow, /Resolve inherited production D1 binding/u);
  assert.match(backupWorkflow, /D1_DATABASE_ID: \$\{\{ steps\.d1\.outputs\.database_id \}\}/u);
  assert.match(backupWorkflow, /scripts\/backup-d1-logical\.ts/u);
  assert.match(backupWorkflow, /gzip -t/u);
  assert.match(backupWorkflow, /if-no-files-found: error/u);
  assert.doesNotMatch(backupWorkflow, /wrangler d1 export/u);
});
