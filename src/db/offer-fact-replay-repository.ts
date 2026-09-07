import { inferOfferFacts, OFFER_FACT_RULE_VERSION } from "../catalog/offer-facts.js";
import { OFFER_FACT_DEFINITIONS } from "../catalog/types.js";
import { accountReads, firstMeasured } from "./read-accounting.js";
import { sellerOfferFactWrites } from "./offer-fact-repository.js";
import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export const OFFER_FACT_REPLAY_BATCH_SIZE = 25;
const MAX_COHORT_BYTES = 128 * 1024;

interface CoverageGroup {
  key: string;
  listings: number;
  condition: number;
  included: number;
  warranty: number;
  sale_unit: number;
}
interface Coverage {
  byShop: CoverageGroup[];
  byCategory: CoverageGroup[];
}
interface ReplayRow {
  rule_version: number;
  after_id: number;
  max_product_id: number;
  scanned_count: number;
  active_count: number;
  coverage_json: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
}
interface Listing {
  id: number;
  shop_key: string;
  source_id: string;
  title: string;
  condition_text: string;
  is_active: number;
  primary_category_id: string;
  last_seen_at: string;
}

function progress(row: ReplayRow) {
  return {
    ruleVersion: row.rule_version,
    afterId: row.after_id,
    maxProductId: row.max_product_id,
    scannedCount: row.scanned_count,
    activeCount: row.active_count,
    coverage: JSON.parse(row.coverage_json) as Coverage,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function readState(db: ReadableDatabase) {
  return firstMeasured<ReplayRow>(
    db
      .prepare(`SELECT rule_version, after_id, max_product_id,
    scanned_count, active_count, coverage_json, started_at, updated_at, completed_at
    FROM product_offer_fact_replays WHERE rule_version = ?`)
      .bind(OFFER_FACT_RULE_VERSION),
  );
}

export async function readOfferFactReplay(db: ReadableDatabase) {
  const row = await readState(db);
  return row ? progress(row) : null;
}

function addCoverage(bucket: CoverageGroup[], key: string, groups: Set<string>) {
  let row = bucket.find((entry) => entry.key === key);
  if (!row) {
    row = { key, listings: 0, condition: 0, included: 0, warranty: 0, sale_unit: 0 };
    bucket.push(row);
  }
  row.listings++;
  for (const group of ["condition", "included", "warranty", "sale_unit"] as const) {
    if (groups.has(group)) row[group]++;
  }
}

/** A durable, bounded step. The token and snapshot guard fence concurrent crawls and replay calls. */
export async function stepOfferFactReplay(
  database: QueryableDatabase,
  now = new Date().toISOString(),
) {
  const usage = accountReads(database);
  const db = usage.db;
  let state = await readState(db);
  if (!state) {
    await db
      .prepare(`INSERT INTO product_offer_fact_replays
      (rule_version, max_product_id, started_at, updated_at)
      SELECT ?, COALESCE((SELECT id FROM products ORDER BY id DESC LIMIT 1), 0), ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM product_offer_fact_replays WHERE rule_version = ?)`)
      .bind(OFFER_FACT_RULE_VERSION, now, now, OFFER_FACT_RULE_VERSION)
      .run();
    state = await readState(db);
  }
  if (!state) throw new Error("offer_fact_replay_initialization_failed");
  if (state.completed_at) return progress(state);
  const rows = await db
    .prepare(`SELECT id, shop_key, source_id, substr(title,1,4000) AS title,
    substr(condition_text,1,4000) AS condition_text, is_active, primary_category_id, last_seen_at
    FROM products WHERE id > ? AND id <= ? ORDER BY id LIMIT ?`)
    .bind(state.after_id, state.max_product_id, OFFER_FACT_REPLAY_BATCH_SIZE)
    .all<Listing>();
  const listings: Listing[] = [];
  for (const row of rows.results) {
    const candidate = [...listings, row];
    if (new TextEncoder().encode(JSON.stringify(candidate)).byteLength > MAX_COHORT_BYTES) break;
    listings.push(row);
  }
  if (rows.results.length && !listings.length)
    throw new Error("offer_fact_replay_listing_too_large");
  const complete =
    listings.length === rows.results.length &&
    (rows.results.length < OFFER_FACT_REPLAY_BATCH_SIZE ||
      listings.at(-1)?.id === state.max_product_id);
  const afterId = complete ? state.max_product_id : listings.at(-1)!.id;
  const coverage = JSON.parse(state.coverage_json) as Coverage;
  let active = 0;
  for (const listing of listings) {
    if (!listing.is_active) continue;
    active++;
    const facts = inferOfferFacts(listing.title, listing.condition_text, listing.last_seen_at);
    const groups = new Set(
      facts.map(
        (fact) => OFFER_FACT_DEFINITIONS.find((definition) => definition.id === fact.factId)!.group,
      ),
    );
    addCoverage(coverage.byShop, listing.shop_key, groups);
    addCoverage(coverage.byCategory, listing.primary_category_id, groups);
  }
  const token = crypto.randomUUID();
  const claim = db
    .prepare(`UPDATE product_offer_fact_replays SET
    after_id = ?, scanned_count = scanned_count + ?, active_count = active_count + ?,
    coverage_json = ?, step_token = ?, updated_at = ?, completed_at = ?
    WHERE rule_version = ? AND after_id = ? AND completed_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS (
          SELECT 1 FROM products p WHERE p.id = json_extract(expected.value, '$.id')
            AND p.shop_key = json_extract(expected.value, '$.shop_key')
            AND p.source_id = json_extract(expected.value, '$.source_id')
            AND substr(p.title,1,4000) = json_extract(expected.value, '$.title')
            AND substr(p.condition_text,1,4000) = json_extract(expected.value, '$.condition_text')
            AND p.is_active = json_extract(expected.value, '$.is_active')
            AND p.primary_category_id = json_extract(expected.value, '$.primary_category_id')
      ))`)
    .bind(
      afterId,
      listings.length,
      active,
      JSON.stringify(coverage),
      token,
      now,
      complete ? now : null,
      OFFER_FACT_RULE_VERSION,
      state.after_id,
      JSON.stringify(listings),
    );
  await db.batch([
    claim,
    ...listings.flatMap((listing) =>
      sellerOfferFactWrites(
        db,
        listing.shop_key,
        listing.source_id,
        listing.title,
        listing.condition_text,
        listing.last_seen_at,
        { ruleVersion: OFFER_FACT_RULE_VERSION, token },
      ),
    ),
  ]);
  const result = await readOfferFactReplay(db);
  console.log(
    JSON.stringify({
      event: "offer_fact_replay_step",
      afterId: result?.afterId,
      scannedCount: result?.scannedCount,
      rowsRead: usage.rowsRead(),
      rowsWritten: usage.rowsWritten(),
      statementCount: usage.statementCount(),
    }),
  );
  return result;
}
