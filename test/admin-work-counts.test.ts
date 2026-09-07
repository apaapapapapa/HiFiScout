import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { readFileSync } from "node:fs";
import {
  adminWorkCountLabel,
  loadAdminWorkCounts,
  type AdminWorkCounts,
} from "../frontend/admin-work-counts.js";
import { parseAdminWorkCountCursor } from "../src/api/admin-work-counts-contract.js";
import { readAdminWorkCounts } from "../src/db/admin-work-counts-repository.js";
import { normalizeCatalogModel } from "../src/catalog/knowledge-catalog.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const AT = "2026-09-07T00:00:00.000Z";
const START = { bucketKey: "", afterId: 0 };
const MIGRATION = "0110_admin_work_counts.sql";

function insertCatalog(
  sqlite: ReturnType<typeof migratedSqlite>["sqlite"],
  manufacturer: string,
  model: string,
) {
  return Number(
    sqlite
      .prepare(`INSERT INTO knowledge_catalog_products
    (manufacturer_id, canonical_model, normalized_model, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)`)
      .run(manufacturer, model, normalizeCatalogModel(model), AT, AT).lastInsertRowid,
  );
}

test("work counts include only actionable statuses and cap at 100", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec(
      "DELETE FROM product_correction_reports; DELETE FROM knowledge_catalog_candidates;",
    );
    const report =
      sqlite.prepare(`INSERT INTO product_correction_reports(product_key, reason, status, created_at, updated_at)
      VALUES ('catalog:1', 'wrong_model', ?, '2020-01-01', ?)`);
    const candidate =
      sqlite.prepare(`INSERT INTO knowledge_catalog_candidates(manufacturer_id, normalized_model, review_status, last_reviewed_at, created_at, updated_at)
      VALUES ('luxman', ?, ?, ?, ?, ?)`);
    report.run("in_review", AT);
    for (const status of ["accepted", "rejected", "duplicate"]) report.run(status, AT);
    candidate.run("matched", "matched", AT, AT, AT);
    candidate.run("ignored", "ignored", AT, AT, AT);
    let counts = await readAdminWorkCounts(db, START);
    assert.equal(counts.reports, 1, "unresolved older reports remain work");
    assert.equal(counts.candidates, 0);
    for (let i = 0; i < 110; i++) {
      if (i < 99) report.run("open", AT);
      candidate.run(String(i), "pending", AT, AT, AT);
      if (i === 98) {
        counts = await readAdminWorkCounts(db, START);
        assert.equal(counts.candidates, 99);
      }
    }
    counts = await readAdminWorkCounts(db, START);
    assert.equal(counts.reports, 100);
    assert.equal(counts.candidates, 100);
    assert.deepEqual([0, 1, 99, 100, 1000, null].map(adminWorkCountLabel), [
      "0",
      "1",
      "99",
      "99+",
      "99+",
      "—",
    ]);
  } finally {
    sqlite.close();
  }
});

test("duplicate projection backfills and follows inserts, moves, rejection, revival and deletion", async () => {
  const { sqlite, db } = migratedSqlite({ before: MIGRATION });
  try {
    sqlite.exec("DELETE FROM knowledge_catalog_products");
    const a = insertCatalog(sqlite, "luxman", "C-10");
    const b = insertCatalog(sqlite, "luxman", "C10");
    const c = insertCatalog(sqlite, "denon", "PMA-2500NE");
    sqlite.exec(readFileSync(new URL(`../migrations/${MIGRATION}`, import.meta.url), "utf8"));
    const ids = () =>
      sqlite
        .prepare("SELECT product_id FROM knowledge_catalog_duplicate_members ORDER BY product_id")
        .all()
        .map((r) => Number(r.product_id));
    assert.deepEqual(ids(), [a, b]);
    const d = insertCatalog(sqlite, "denon", "PMA2500NE");
    assert.deepEqual(ids(), [a, b, c, d]);
    sqlite
      .prepare(
        "UPDATE knowledge_catalog_products SET canonical_model = 'C11', normalized_model = 'C11' WHERE id = ?",
      )
      .run(b);
    assert.deepEqual(ids(), [c, d]);
    sqlite
      .prepare(
        "UPDATE knowledge_catalog_products SET verification_status = 'rejected' WHERE id = ?",
      )
      .run(c);
    assert.deepEqual(ids(), []);
    sqlite
      .prepare(
        "UPDATE knowledge_catalog_products SET verification_status = 'verified' WHERE id = ?",
      )
      .run(c);
    assert.deepEqual(ids(), [c, d]);
    sqlite.prepare("DELETE FROM knowledge_catalog_products WHERE id = ?").run(d);
    assert.deepEqual(ids(), []);
    assert.deepEqual((await readAdminWorkCounts(db, START)).duplicateIdentities, []);
  } finally {
    sqlite.close();
  }
});

test("duplicate counts refine manufacturer/revision identities and carry groups across pages", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    sqlite.exec("DELETE FROM knowledge_catalog_products");
    for (let i = 0; i < 197; i++) insertCatalog(sqlite, `unrelated-${i}`, "AAA-1");
    insertCatalog(sqlite, "luxman", "L-509 MK II");
    insertCatalog(sqlite, "luxman", "L-509MKII");
    insertCatalog(sqlite, "luxman", "L509MK2");
    insertCatalog(sqlite, "bw", "805 D4");
    insertCatalog(sqlite, "bowers-wilkins", "805D4");
    // 2 B&W + 197 unrelated + the first LUXMAN row fill page one; its peers arrive on page two.
    const pages: AdminWorkCounts[] = [];
    let calls = 0;
    vi.stubGlobal("fetch", async (path: string) => {
      calls++;
      const cursor = parseAdminWorkCountCursor(new URL(path, "https://admin.test"));
      assert.ok(cursor);
      return new Response(JSON.stringify(await readAdminWorkCounts(db, cursor)));
    });
    await loadAdminWorkCounts((value) => pages.push(value), new AbortController().signal);
    assert.equal(calls, 2);
    assert.equal(pages[0].duplicates, null, "a partial scan cannot claim an exact count");
    assert.equal(pages.at(-1)?.duplicates, 2, "three catalog rows still make just one group");
  } finally {
    vi.unstubAllGlobals();
    sqlite.close();
  }
});

test("count loading stops at 100 groups and never publishes a response after cancellation", async () => {
  const controller = new AbortController();
  let calls = 0;
  vi.stubGlobal("fetch", async () => {
    calls++;
    return new Response(
      JSON.stringify({
        reports: 99,
        candidates: 100,
        duplicateIdentities: Array.from({ length: 100 }, (_, i) => [
          `luxman M${i}`,
          `luxman M${i}`,
        ]).flat(),
        nextDuplicateCursor: { bucketKey: "MORE", afterId: 500 },
      }),
    );
  });
  try {
    const counts: AdminWorkCounts[] = [];
    await loadAdminWorkCounts((value) => counts.push(value), controller.signal);
    assert.equal(calls, 1);
    assert.deepEqual(counts, [{ reports: 99, candidates: 100, duplicates: 100 }]);
    vi.stubGlobal("fetch", async () => {
      controller.abort();
      return new Response(
        JSON.stringify({
          reports: 0,
          candidates: 0,
          duplicateIdentities: [],
          nextDuplicateCursor: null,
        }),
      );
    });
    await loadAdminWorkCounts(() => assert.fail("stale count response"), controller.signal);
  } finally {
    vi.unstubAllGlobals();
  }
});

test("count cursors reject malformed or incomplete positions", () => {
  const parse = (query: string) =>
    parseAdminWorkCountCursor(new URL(`https://admin.test/?${query}`));
  assert.deepEqual(parse(""), START);
  assert.deepEqual(parse("afterKey=C10&afterId=5"), { bucketKey: "C10", afterId: 5 });
  for (const query of [
    "afterId=1",
    "afterKey=C10",
    "afterKey=C10&afterId=-1",
    "afterKey=%00&afterId=5",
    "afterKey=C10&afterId=1e2",
  ])
    assert.equal(parse(query), null);
});
