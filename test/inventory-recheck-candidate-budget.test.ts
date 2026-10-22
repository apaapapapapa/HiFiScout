import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { recordCostSample } from "../scripts/harness/cost.js";
import { selectInventoryRecheckCandidate } from "../src/db/inventory-recheck-repository.js";
import type { QueryableDatabase } from "../src/db/types.js";
import { database } from "./helpers/d1-write-budget.js";
import { measureD1Cost } from "./helpers/harness-cost.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import {
  assertNoGrowingTableScans,
  assertNoSortBeforeLimit,
  queryPlan,
  readsThroughIndex,
  recordingDatabase,
  selects,
} from "./helpers/query-plan.js";

const SHOP = "audiounion";
const NOW = "2026-10-20T00:00:00.000Z";
const BEFORE = "2026-10-19T00:00:00.000Z";
const DETAIL = "https://www.audiounion.jp/ct/detail/used/";
const ATTEMPT_INDEX = "idx_products_inventory_recheck_attempt";
const CONFIRM_INDEX = "idx_products_inventory_recheck_confirm";

/**
 * The selection order the repository must keep: one walk sorting every eligible listing, with
 * due confirmations of an earlier unavailable result first, then never-attempted listings. Kept
 * here as the oracle the indexed seeks are compared against.
 */
const REFERENCE_SELECTION = `
  SELECT id FROM products
  WHERE shop_key = ? AND is_active = 1 AND last_seen_at <= ?
    AND (last_inventory_check_attempt_at IS NULL OR last_inventory_check_attempt_at <= ?)
    AND source_url LIKE '${DETAIL}%'
  ORDER BY CASE
      WHEN inventory_check_failures > 0 AND last_inventory_check_attempt_at IS NOT NULL THEN 0
      WHEN last_inventory_check_attempt_at IS NULL THEN 1
      ELSE 2 END,
    last_inventory_check_attempt_at ASC, last_seen_at ASC, id ASC
  LIMIT 1`;

/** Deterministic PRNG so a failing seed reproduces. */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("indexed candidate seeks pick the reference listing for every randomized window", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    // A few shared instants force ties, so the last_seen_at and id tie-breaks decide the choice.
    const instants = [
      "2026-10-17T00:00:00.000Z",
      "2026-10-18T00:00:00.000Z",
      "2026-10-18T12:00:00.000Z",
      BEFORE,
      "2026-10-19T12:00:00.000Z",
      NOW,
    ];
    const windows = [...instants, "2026-10-18T06:00:00.000Z", "2026-10-16T00:00:00.000Z"];
    const insert = sqlite.prepare(`INSERT INTO products(shop_key,source_id,title,source_url,
        first_seen_at,last_seen_at,last_changed_at,last_activity_at,stock_status,is_active,
        last_inventory_check_attempt_at,inventory_check_failures)
      VALUES (?,?,?,?,?,?,?,?,'in_stock',?,?,?)`);
    const reference = sqlite.prepare(REFERENCE_SELECTION);
    const answers = { none: 0, confirmation: 0, neverAttempted: 0, attempted: 0 };
    for (let trial = 0; trial < 300; trial += 1) {
      const next = random(trial + 1);
      const pick = <T>(values: readonly T[]) => values[Math.floor(next() * values.length)]!;
      const shop = `${SHOP}-${trial}`;
      const rows = Math.floor(next() * 30);
      sqlite.exec("BEGIN");
      for (let row = 0; row < rows; row += 1) {
        const roll = next();
        const url =
          roll < 0.08
            ? `https://www.audiounion.jp/ct/detail/new/${row}`
            : roll < 0.12
              ? `HTTPS://WWW.AUDIOUNION.JP/ct/detail/used/${row}`
              : `${DETAIL}${row}`;
        const attemptRoll = next();
        const attempt = attemptRoll < 0.35 ? null : attemptRoll < 0.4 ? "" : pick(instants);
        insert.run(
          next() < 0.85 ? shop : `${shop}-other`,
          `s${row}`,
          `T${row}`,
          url,
          instants[0]!,
          pick(instants),
          instants[0]!,
          instants[0]!,
          next() < 0.85 ? 1 : 0,
          attempt,
          next() < 0.15 ? 1 : 0,
        );
      }
      sqlite.exec("COMMIT");
      for (let window = 0; window < 6; window += 1) {
        const staleBefore = pick(windows);
        const retryBefore = pick(windows);
        const expected = reference.get(shop, staleBefore, retryBefore)?.id ?? null;
        const actual = await selectInventoryRecheckCandidate(db, shop, {
          staleBefore,
          retryBefore,
          candidateUrlPrefix: DETAIL,
        });
        assert.equal(
          actual?.id ?? null,
          expected,
          `trial ${trial}: staleBefore=${staleBefore} retryBefore=${retryBefore}`,
        );
        if (!actual) answers.none += 1;
        else if (actual.inventory_check_failures > 0) answers.confirmation += 1;
        else if (actual.last_inventory_check_attempt_at === null) answers.neverAttempted += 1;
        else answers.attempted += 1;
      }
    }
    // Every seek and the empty answer must each have decided a substantial share of windows.
    assert.ok(
      Object.values(answers).every((count) => count >= 100),
      JSON.stringify(answers),
    );
  } finally {
    sqlite.close();
  }
});

test("candidate selection seeks the attempt index in its own order", async () => {
  const { sqlite, db: inner } = migratedSqlite();
  try {
    const { db, executed } = recordingDatabase(inner);
    await selectInventoryRecheckCandidate(db, SHOP, {
      staleBefore: BEFORE,
      retryBefore: BEFORE,
      candidateUrlPrefix: DETAIL,
    });
    assert.equal(selects(executed).length, 1);
    assertNoGrowingTableScans(sqlite, executed, { label: "inventory recheck candidate" });
    assertNoSortBeforeLimit(sqlite, executed, "inventory recheck candidate");
    const plan = queryPlan(sqlite, selects(executed)[0]!);
    const detail = plan.map((step) => step.detail).join("\n");
    assert.ok(readsThroughIndex(plan, "products", ATTEMPT_INDEX), detail);
    assert.ok(readsThroughIndex(plan, "products", CONFIRM_INDEX), detail);
    // Never-attempted listings are bounded by last_seen_at, attempted ones by retryBefore.
    assert.match(detail, /last_inventory_check_attempt_at=\? AND last_seen_at<\?/);
    assert.match(detail, /last_inventory_check_attempt_at<\?/);
  } finally {
    sqlite.close();
  }
});

/** Listings `from..to` of `shop` seen at `seen` and last attempted at `attempt`. */
function insertListings(
  db: QueryableDatabase,
  [from, to]: [number, number],
  shop: string,
  {
    seen,
    attempt,
    active = 1,
    failures = 0,
  }: { seen: string; attempt: string | null; active?: number; failures?: number },
) {
  return db
    .prepare(`WITH RECURSIVE n(i) AS (SELECT CAST(? AS INTEGER) UNION ALL SELECT i+1 FROM n WHERE i < ?)
      INSERT INTO products(id,shop_key,source_id,title,source_url,first_seen_at,last_seen_at,
        last_changed_at,last_activity_at,stock_status,is_active,last_inventory_check_attempt_at,
        inventory_check_failures)
      SELECT i,?,'s'||i,'T'||i,?||i,?,?,?,?,'in_stock',?,?,? FROM n`)
    .bind(from, to, shop, DETAIL, seen, seen, seen, seen, active, attempt, failures)
    .run();
}

const setAttempt = (db: QueryableDatabase, ids: [number, number], attempt: string | null) =>
  db
    .prepare(
      "UPDATE products SET last_inventory_check_attempt_at = ? WHERE id BETWEEN ? AND ? AND is_active = 1",
    )
    .bind(attempt, ids[0], ids[1])
    .run();

test("candidate selection reads the due listings, not the shop's recently seen or checked ones", async () => {
  const { db, dispose } = await database();
  const fixture = ["test/inventory-recheck-candidate-budget.test.ts"];
  const window = { staleBefore: BEFORE, retryBefore: BEFORE, candidateUrlPrefix: DETAIL };
  const fresh = "2026-10-19T23:00:00.000Z";
  const stale = "2026-10-10T00:00:00.000Z";
  const checked = "2026-10-19T18:00:00.000Z";
  const due = "2026-10-17T00:00:00.000Z";
  // Ids 1-3 are never attempted, 4-8 were attempted three days ago and 9-10 were found unavailable
  // three days ago; the rest is bulk.
  const neverAttempted: [number, number] = [1, 3];
  const oldestAttempts: [number, number] = [4, 8];
  const confirmations: [number, number] = [9, 10];
  try {
    await insertListings(db, neverAttempted, SHOP, { seen: stale, attempt: null });
    await insertListings(db, oldestAttempts, SHOP, { seen: stale, attempt: due });
    await insertListings(db, confirmations, SHOP, { seen: stale, attempt: due, failures: 1 });

    let next = 100;
    let bulk = 0;
    const span = (count: number): [number, number] => [next, (next += count) - 1];
    const reads: Record<string, number[]> = {
      confirmation: [],
      "never-attempted": [],
      "oldest-attempt": [],
    };
    for (const size of [1000, 5000]) {
      // Growth in everything the selector must not visit: half recently seen and never attempted,
      // half stale but checked within the retry interval, plus inactive and other-shop listings.
      const grow = size - bulk;
      bulk = size;
      await insertListings(db, span(grow / 2), SHOP, { seen: fresh, attempt: null });
      await insertListings(db, span(grow / 2), SHOP, { seen: stale, attempt: checked });
      await insertListings(db, span(grow / 4), SHOP, { seen: stale, attempt: null, active: 0 });
      await insertListings(db, span(grow / 4), "other", { seen: stale, attempt: null });
      // Unavailable listings rechecked within the retry interval: the confirmation seek's own index
      // holds them, and must stop before them.
      await insertListings(db, span(grow / 10), SHOP, {
        seen: stale,
        attempt: checked,
        failures: 1,
      });

      for (const [scenario, expected] of [
        ["confirmation", 9],
        ["never-attempted", 1],
        ["oldest-attempt", 4],
        ["none-due", null],
      ] as const) {
        if (scenario === "never-attempted") await setAttempt(db, confirmations, checked);
        if (scenario === "oldest-attempt") await setAttempt(db, neverAttempted, checked);
        if (scenario === "none-due") await setAttempt(db, oldestAttempts, checked);
        const boundary = measureD1Cost(db);
        const candidate = await selectInventoryRecheckCandidate(boundary.db, SHOP, window);
        const cost = boundary.metrics();
        console.log(JSON.stringify({ sample: `inventory-recheck-${scenario}-${size}`, ...cost }));
        assert.equal(candidate?.id ?? null, expected, `${scenario} at ${size}`);
        assert.equal(cost.sqlStatements, 1);
        assert.equal(cost.rowsWritten, 0, JSON.stringify(cost));
        assert.ok(cost.rowsRead !== null && cost.rowsRead <= 20, JSON.stringify(cost));
        if (scenario !== "none-due") {
          await recordCostSample(
            `inventory-recheck-${scenario}-${size}`,
            "local-workerd",
            cost,
            fixture,
            [
              `Next ${scenario} candidate among ${size} active listings of the shop, half seen within the hour and half checked within the retry interval; real migrated D1.`,
            ],
          );
          reads[scenario]!.push(cost.rowsRead);
        }
      }
      await setAttempt(db, neverAttempted, null);
      await setAttempt(db, oldestAttempts, due);
      await setAttempt(db, confirmations, due);
    }
    for (const [scenario, values] of Object.entries(reads))
      assert.equal(
        new Set(values).size,
        1,
        `${scenario} reads must not grow with the shop: ${values}`,
      );
  } finally {
    await dispose();
  }
}, 120_000);

test("listings seen again after an old check are the attempted seek's only per-row cost", async () => {
  const { db, dispose } = await database();
  const window = { staleBefore: BEFORE, retryBefore: BEFORE, candidateUrlPrefix: DETAIL };
  const fresh = "2026-10-19T23:00:00.000Z";
  const stale = "2026-10-10T00:00:00.000Z";
  try {
    // Ids 1-5 are due by attempt; 100.. were checked even earlier but the crawl has seen them since.
    await insertListings(db, [1, 5], SHOP, { seen: stale, attempt: "2026-10-17T00:00:00.000Z" });
    for (const seenAgain of [50, 200]) {
      await db.prepare("DELETE FROM products WHERE id >= 100").run();
      await insertListings(db, [100, 99 + seenAgain], SHOP, {
        seen: fresh,
        attempt: "2026-10-12T00:00:00.000Z",
      });
      const boundary = measureD1Cost(db);
      const candidate = await selectInventoryRecheckCandidate(boundary.db, SHOP, window);
      const cost = boundary.metrics();
      console.log(
        JSON.stringify({ diagnostic: `inventory-recheck-seen-again-${seenAgain}`, ...cost }),
      );
      assert.equal(candidate?.id, 1);
      // Each is stepped over once inside the retry window; none is ever selected while fresh.
      assert.ok(
        cost.rowsRead !== null && cost.rowsRead >= seenAgain && cost.rowsRead <= seenAgain + 5,
        JSON.stringify(cost),
      );
    }
  } finally {
    await dispose();
  }
}, 120_000);
