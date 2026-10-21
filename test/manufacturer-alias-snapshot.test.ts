import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

/** A fresh module instance stands in for a new isolate: its in-memory alias cache is empty. */
async function freshIsolate() {
  vi.resetModules();
  return (await import("../src/db/manufacturer-repository.js")).listManufacturerAliasEvidence;
}

/**
 * Resolver-visible and hidden evidence side by side: global and shop aliases, a rejected alias,
 * an admin control that stays visible while rejected, and aliases of an unverified manufacturer.
 */
function seedSql(count: number): string {
  return `
    INSERT INTO knowledge_catalog_manufacturers(
      id,canonical_name,verification_status,source,created_at,updated_at
    ) VALUES ('snap-brand','Snap Brand','verified','test','2026','2026'),
             ('snap-hidden','Snap Hidden','pending','test','2026','2026');
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${count})
    INSERT INTO knowledge_catalog_manufacturer_aliases(
      manufacturer_id,alias,normalized_alias,verification_status,source,rule_version,created_at,updated_at
    ) SELECT CASE WHEN i % 7 = 0 THEN 'snap-hidden' ELSE 'snap-brand' END,
             'Snap '||i, printf('snapalias%05d',i),
             CASE WHEN i % 5 = 0 THEN 'rejected' WHEN i % 3 = 0 THEN 'pending' ELSE 'verified' END,
             CASE WHEN i % 10 = 0 THEN 'admin_alias_control' ELSE 'test' END,
             1 + i % 2, '2026', '2026'
      FROM n;
    INSERT INTO knowledge_catalog_shop_manufacturer_aliases(
      manufacturer_id,alias,normalized_alias,verification_status,source,created_at,updated_at,shop_key
    ) VALUES ('snap-brand','Shop Snap','shopsnap','verified','admin_alias_control','2026','2026','shop-a'),
             ('snap-brand','Shop Rejected','shoprejected','rejected','test','2026','2026','shop-b');
  `;
}

const snapshotRow = (sqlite: ReturnType<typeof migratedSqlite>["sqlite"]) =>
  sqlite
    .prepare(
      `SELECT s.version, s.version = c.version AS current
       FROM manufacturer_alias_evidence_snapshot s, admin_manufacturer_registry_clock c`,
    )
    .get() as { version: number; current: number } | undefined;

test("a fresh isolate reads the persisted snapshot instead of scanning every alias", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/manufacturer-alias-snapshot.test.ts"];
  try {
    const fresh: string[] = [];
    for (const size of [100, 1000]) {
      // Each size gets its own manufacturers; the inserts advance the clock like any alias edit.
      await db
        .prepare(
          seedSql(size).replaceAll("snap-", `snap${size}-`).replaceAll("snapalias", `s${size}a`),
        )
        .run();
      const stored = await db
        .prepare(
          `SELECT (SELECT COUNT(*) FROM knowledge_catalog_manufacturer_aliases)
            + (SELECT COUNT(*) FROM knowledge_catalog_shop_manufacturer_aliases) AS n`,
        )
        .first<number>("n");

      const rebuild = measureD1Cost(db);
      const built = await (await freshIsolate())(rebuild.db);
      const rebuildCost = rebuild.metrics();
      assert.ok(built.length > 0);
      if (size === 1000) {
        await recordCostSample(
          `manufacturer-alias-rebuild-${size}`,
          "local-workerd",
          rebuildCost,
          fixture,
          ["The first fresh isolate after an edit scans every alias and stores the snapshot once."],
        );
        console.log(
          JSON.stringify({ sample: `manufacturer-alias-rebuild-${size}`, ...rebuildCost }),
        );
        assert.equal(rebuildCost.rowsWritten, 1, JSON.stringify(rebuildCost));
      }

      const reuse = measureD1Cost(db);
      const reused = await (await freshIsolate())(reuse.db);
      const reuseCost = reuse.metrics();
      assert.deepEqual(reused, built, "the snapshot returns exactly what the scan returned");
      const sample = `manufacturer-alias-fresh-isolate-${size}`;
      await recordCostSample(sample, "local-workerd", reuseCost, fixture, [
        `A fresh isolate's alias evidence with ${stored} aliases stored: the clock and one snapshot row.`,
      ]);
      console.log(JSON.stringify({ sample, ...reuseCost }));
      assert.equal(reuseCost.sqlStatements, 2);
      assert.equal(reuseCost.rowsWritten, 0);
      assert.ok(reuseCost.rowsRead !== null && reuseCost.rowsRead <= 3, JSON.stringify(reuseCost));
      assert.ok(
        rebuildCost.rowsRead !== null && rebuildCost.rowsRead > size,
        JSON.stringify(rebuildCost),
      );
      fresh.push(JSON.stringify(reuseCost));
    }
    assert.equal(new Set(fresh).size, 1, `fresh-isolate cost must not grow with aliases: ${fresh}`);
  } finally {
    await dispose();
  }
}, 60_000);

test("snapshot reuse returns the scan's evidence and follows every resolver-visible edit", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seedSql(60));
    const scanned = await (await freshIsolate())(db);
    assert.ok(snapshotRow(sqlite)?.current, "the first scan stores the current revision");
    const reused = await (await freshIsolate())(db);
    assert.deepEqual(reused, scanned);
    assert.ok(reused.some((alias) => alias.shopKey === "shop-a"));
    assert.ok(reused.every((alias) => alias.manufacturerId !== "snap-hidden"));
    assert.ok(reused.some((alias) => alias.verificationStatus === "rejected"));
    assert.ok(!reused.some((alias) => alias.normalizedAlias === "shoprejected"));

    const edits = [
      "UPDATE knowledge_catalog_manufacturer_aliases SET rule_version=7 WHERE normalized_alias='snapalias00001'",
      "UPDATE knowledge_catalog_manufacturers SET canonical_name='Snap Renamed' WHERE id='snap-brand'",
      "UPDATE knowledge_catalog_manufacturers SET verification_status='verified' WHERE id='snap-hidden'",
      "DELETE FROM knowledge_catalog_shop_manufacturer_aliases WHERE normalized_alias='shopsnap'",
    ];
    for (const edit of edits) {
      sqlite.exec(edit);
      const expected = await (await freshIsolate())(db);
      assert.ok(snapshotRow(sqlite)?.current, `rebuilt after: ${edit}`);
      assert.deepEqual(await (await freshIsolate())(db), expected, `reused after: ${edit}`);
    }
    const final = await (await freshIsolate())(db);
    assert.equal(final.find((alias) => alias.normalizedAlias === "snapalias00001")?.ruleVersion, 7);
    assert.ok(final.every((alias) => alias.canonicalName !== "Snap Brand"));
    assert.ok(final.some((alias) => alias.manufacturerId === "snap-hidden"));
    assert.ok(!final.some((alias) => alias.shopKey === "shop-a"));
  } finally {
    sqlite.close();
  }
});

test("a snapshot from another definition or with malformed rows is rebuilt, never trusted", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seedSql(20));
    const expected = await (await freshIsolate())(db);

    sqlite.exec("UPDATE manufacturer_alias_evidence_snapshot SET definition='fnv1a:00000000'");
    assert.deepEqual(await (await freshIsolate())(db), expected);
    const restored = sqlite
      .prepare("SELECT definition FROM manufacturer_alias_evidence_snapshot")
      .get() as { definition: string };
    assert.notEqual(
      restored.definition,
      "fnv1a:00000000",
      "the current definition is stored again",
    );

    for (const rowsJson of [
      "not json",
      "{}",
      '[["snap-brand"]]',
      '[[1,"",2,3,4,"verified","x",1]]',
    ]) {
      sqlite.prepare("UPDATE manufacturer_alias_evidence_snapshot SET rows_json=?").run(rowsJson);
      assert.deepEqual(await (await freshIsolate())(db), expected, rowsJson);
      const repaired = sqlite
        .prepare("SELECT rows_json FROM manufacturer_alias_evidence_snapshot")
        .get() as { rows_json: string };
      assert.equal(JSON.parse(repaired.rows_json).length, expected.length, "the row is repaired");
    }
  } finally {
    sqlite.close();
  }
});

/** The same database with `onPrepare` run on every statement before it is prepared. */
function preparing(db: QueryableDatabase, onPrepare: (sql: string) => void): QueryableDatabase {
  return new Proxy(db, {
    get(target, key) {
      if (key === "prepare") {
        return (sql: string) => {
          onPrepare(sql);
          return target.prepare(sql);
        };
      }
      const value: unknown = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Runs `onStatement` before the first statement whose SQL matches `pattern`. */
function interceptBefore(
  db: QueryableDatabase,
  pattern: RegExp,
  onStatement: () => void,
): QueryableDatabase {
  let fired = false;
  return preparing(db, (sql) => {
    if (!fired && pattern.test(sql)) {
      fired = true;
      onStatement();
    }
  });
}

test("an edit during the scan or before the write never files a snapshot under a stale revision", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seedSql(20));
    const edit = () =>
      sqlite.exec(
        "UPDATE knowledge_catalog_manufacturer_aliases SET rule_version=rule_version+1 WHERE normalized_alias='snapalias00002'",
      );

    // The scan runs after the edit, so the second clock read no longer matches the first.
    await (
      await freshIsolate()
    )(interceptBefore(db, /WITH aliases AS/u, edit));
    assert.equal(snapshotRow(sqlite), undefined, "a scan spanning an edit is not persisted");

    // The scan is consistent, but the clock moves before the conditional write lands.
    await (
      await freshIsolate()
    )(interceptBefore(db, /INSERT INTO manufacturer_alias_evidence_snapshot/u, edit));
    assert.equal(snapshotRow(sqlite), undefined, "the write requires the scanned revision");

    const current = await (await freshIsolate())(db);
    assert.ok(snapshotRow(sqlite)?.current);
    assert.equal(
      current.find((alias) => alias.normalizedAlias === "snapalias00002")?.ruleVersion,
      3,
    );
  } finally {
    sqlite.close();
  }
});

test("alias evidence survives a missing snapshot table and a failed snapshot write", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(seedSql(20));
    const expected = await (await freshIsolate())(db);

    sqlite.exec("DELETE FROM manufacturer_alias_evidence_snapshot");
    const failing = preparing(db, (sql) => {
      if (/INSERT INTO manufacturer_alias_evidence_snapshot/u.test(sql)) {
        throw new Error("D1_ERROR: write quota exhausted");
      }
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      assert.deepEqual(await (await freshIsolate())(failing), expected);
      assert.match(
        String(errors.mock.calls[0]?.[0]),
        /manufacturer_alias_snapshot_persist_failed/u,
      );
    } finally {
      errors.mockRestore();
    }

    sqlite.exec("DROP TABLE manufacturer_alias_evidence_snapshot");
    assert.deepEqual(await (await freshIsolate())(db), expected, "schemas before 0140 still scan");
  } finally {
    sqlite.close();
  }
});
