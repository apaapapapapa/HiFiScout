import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { applyRemoteMigrations } from "../scripts/apply-remote-migrations.js";
import { workingMigrations } from "../scripts/lib/migration-history.js";
import { applyMigration, localD1 } from "./helpers/local-d1.js";

test("remote migration payloads preserve real trigger SQL and resume after committed history", async () => {
  const local = await localD1();
  const files: string[] = [];
  const payloads: string[] = [];
  const migrations = workingMigrations(process.cwd());
  try {
    for (const migration of migrations.filter(({ name }) => name < "0087")) {
      await applyMigration(local.db, migration);
    }
    const execute = async (input: { command: string } | { file: string }) => {
      if ("command" in input) {
        return [await local.db.prepare("SELECT name FROM d1_migrations ORDER BY id").all()];
      }
      files.push(input.file);
      const sql = readFileSync(input.file, "utf8");
      payloads.push(sql);
      return local.db.batch([local.db.prepare(sql)]);
    };
    await applyRemoteMigrations(migrations, execute, () => {});
    const pending = migrations.filter(({ name }) => name >= "0087");
    assert.equal(payloads.length, pending.length);
    for (let index = 0; index < pending.length; index++) {
      assert.ok(payloads[index].startsWith(pending[index].sql + "\n"));
    }
    assert.equal(
      await local.db
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type='trigger' AND (name LIKE 'product_search_entities_deal_score_%' OR name LIKE 'knowledge_catalog_price_indexes_deal_score_%')",
        )
        .first("count"),
      5,
    );
    await applyRemoteMigrations(migrations, execute, () => {});
    assert.equal(payloads.length, pending.length, "retry must not import committed migrations");
    assert.ok(
      files.every((file) => !existsSync(file)),
      "temporary SQL is removed",
    );
  } finally {
    await local.dispose();
  }
}, 30000);

test("an interrupted migration rolls back SQL and history, stops later files and can resume", async () => {
  const local = await localD1();
  const files: string[] = [];
  const migrations = [
    {
      name: "0001_initial.sql",
      sql: "CREATE TABLE example(id INTEGER); INSERT INTO example VALUES (1);",
    },
    {
      name: "0002_failure.sql",
      sql: "INSERT INTO example VALUES (2); CREATE TABLE undone(id INTEGER); INSERT INTO missing_table VALUES (1);",
    },
    { name: "0003_later.sql", sql: "INSERT INTO example VALUES (3);" },
  ];
  const execute = async (input: { command: string } | { file: string }) => {
    if ("command" in input) return [await local.db.prepare("SELECT name FROM d1_migrations").all()];
    files.push(input.file);
    return local.db.batch([local.db.prepare(readFileSync(input.file, "utf8"))]);
  };
  try {
    await assert.rejects(
      applyRemoteMigrations(migrations, execute, () => {}),
      /missing_table/,
    );
    assert.deepEqual((await local.db.prepare("SELECT id FROM example").all()).results, [{ id: 1 }]);
    assert.equal(
      await local.db.prepare("SELECT COUNT(*) AS count FROM d1_migrations").first("count"),
      1,
    );
    assert.equal(
      await local.db
        .prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name='undone'")
        .first("count"),
      0,
    );
    assert.equal(files.length, 2);
    assert.ok(files.every((file) => !existsSync(file)));
    migrations[1].sql = "INSERT INTO example VALUES (2);";
    await applyRemoteMigrations(migrations, execute, () => {});
    assert.deepEqual((await local.db.prepare("SELECT id FROM example ORDER BY id").all()).results, [
      { id: 1 },
      { id: 2 },
      { id: 3 },
    ]);
    assert.equal(files.length, 4);
  } finally {
    await local.dispose();
  }
});

test("malformed, failed, or newer remote history cannot be treated as an empty database", async () => {
  for (const response of [
    [],
    {},
    [{ success: false, results: [] }],
    [{ success: true, results: [{ name: null }] }],
    [{ success: true, results: [{ name: "9999_newer.sql" }] }],
  ]) {
    let calls = 0;
    await assert.rejects(
      applyRemoteMigrations(
        [],
        async () => {
          calls++;
          return response;
        },
        () => {},
      ),
    );
    assert.equal(calls, 1);
  }
});
