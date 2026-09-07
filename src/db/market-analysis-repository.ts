import { calculateMarketAnalysis } from "../catalog/market-analysis.js";
import type { MarketOffer, MarketSample } from "../catalog/market-analysis.js";
import type { OfferFact, ProductMarketAnalysis } from "../catalog/types.js";
import { effectiveOfferFacts } from "./offer-fact-repository.js";
import { firstMeasured, accountReads } from "./read-accounting.js";
import { withinD1Budget } from "./invocation-budget.js";
import type { QueryableDatabase } from "./types.js";

const MAX_OFFERS = 200;
const MAX_SAMPLES = 500;
const PAGE_SIZE = 5;

/** Public detail reads one persisted row, never current offers or historical samples. */
export async function loadMarketAnalysis(db: QueryableDatabase, id: number): Promise<ProductMarketAnalysis | null> {
  const row = await firstMeasured<{ analysis_json: string }>(db.prepare(`
    SELECT a.analysis_json FROM catalog_market_analysis a JOIN knowledge_catalog_products kp ON kp.id=a.catalog_product_id
    WHERE a.catalog_product_id=? AND kp.verification_status='verified'
      AND NOT EXISTS(SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id=a.catalog_product_id)`)
    .bind(id));
  if (!row) return null;
  try { return JSON.parse(row.analysis_json) as ProductMarketAnalysis; } catch { return null; }
}

/** A queued change invalidates an active claim, preventing a slow refresh from publishing stale facts. */
async function refreshOne(db: QueryableDatabase, id: number, now: Date): Promise<boolean> {
  return withinD1Budget(db, 6, async () => {
    const token = crypto.randomUUID();
    const claim = await db.prepare("UPDATE catalog_market_dirty SET claim_token=?,claimed_at=? WHERE catalog_product_id=? AND claim_token IS NULL")
      .bind(token, now.toISOString(), id).run();
    if (!claim.meta.changes) return false;
    const offers = await db.prepare(`SELECT p.id,p.shop_key,p.price_yen,p.stock_status,p.is_active,p.last_seen_at
      FROM product_search_entity_offers m JOIN products p ON p.id=m.listing_product_id
      WHERE m.entity_id IN (SELECT id FROM product_search_entities WHERE catalog_product_id=?) LIMIT ?`)
      .bind(id, MAX_OFFERS + 1).all<MarketOffer>();
    const samples = await db.prepare(`SELECT id,listing_product_id,shop_key,price_yen,sample_kind,signal_kind,observed_at
      FROM knowledge_catalog_price_index_samples WHERE catalog_product_id=? LIMIT ?`)
      .bind(id, MAX_SAMPLES + 1).all<MarketSample>();
    const limited = offers.results.length > MAX_OFFERS || samples.results.length > MAX_SAMPLES;
    const evidence = limited ? new Map<number, OfferFact[]>() : await effectiveOfferFacts(db, offers.results.map((offer) => offer.id));
    const facts = new Map([...evidence].map(([key, values]) => [key, values.filter((fact) => fact.state === "present").map((fact) => fact.factId)]));
    const analysis: ProductMarketAnalysis = limited
      ? { version: 1, status: "limited", as_of: now.toISOString(), current_conditions: [], months: [] }
      : calculateMarketAnalysis(offers.results, facts, samples.results, now);
    const json = JSON.stringify(analysis);
    const result = await db.batch([
      db.prepare(`INSERT INTO catalog_market_analysis(catalog_product_id,analysis_json,next_refresh_at)
        SELECT ?,?,? WHERE EXISTS(SELECT 1 FROM catalog_market_dirty WHERE catalog_product_id=? AND claim_token=?)
        ON CONFLICT(catalog_product_id) DO UPDATE SET analysis_json=excluded.analysis_json,next_refresh_at=excluded.next_refresh_at
        WHERE catalog_market_analysis.analysis_json IS NOT excluded.analysis_json`)
        .bind(id, json, new Date(now.getTime() + 86_400_000).toISOString(), id, token),
      db.prepare("DELETE FROM catalog_market_dirty WHERE catalog_product_id=? AND claim_token=?").bind(id, token),
    ]);
    return Number(result[1]?.meta?.changes) > 0;
  });
}

/** Five products, at most 200 current offers and 500 samples each, in the existing hourly task. */
export async function maintainMarketAnalysis(db: QueryableDatabase, now = new Date()) {
  const measured = accountReads(db);
  const work = measured.db;
  await work.prepare(`WITH due AS MATERIALIZED (
      SELECT catalog_product_id FROM catalog_market_analysis WHERE next_refresh_at<=?
      ORDER BY next_refresh_at,catalog_product_id LIMIT ?)
    INSERT INTO catalog_market_dirty(catalog_product_id)
    SELECT catalog_product_id FROM due
      WHERE NOT EXISTS(SELECT 1 FROM catalog_market_dirty d WHERE d.catalog_product_id=due.catalog_product_id)`)
    .bind(now.toISOString(), PAGE_SIZE).run();
  // A worker that died after claiming cannot strand the queue. A claim is held for at most one run.
  await work.prepare(`UPDATE catalog_market_dirty SET claim_token=NULL
    WHERE catalog_product_id IN (SELECT catalog_product_id FROM catalog_market_dirty
      WHERE claim_token IS NOT NULL AND claimed_at<? ORDER BY claimed_at,catalog_product_id LIMIT ?)`)
    .bind(new Date(now.getTime() - 60 * 60 * 1000).toISOString(), PAGE_SIZE).run();
  const page = await work.prepare(`SELECT catalog_product_id FROM catalog_market_dirty
    WHERE claim_token IS NULL ORDER BY queued_at,catalog_product_id LIMIT ?`).bind(PAGE_SIZE).all<{ catalog_product_id: number }>();
  let refreshed = 0;
  for (const item of page.results) if (await refreshOne(work, item.catalog_product_id, now)) refreshed++;
  const result = { selected: page.results.length, refreshed };
  console.log(JSON.stringify({ event: "condition_market_analysis_d1_usage", ...result,
    rowsRead: measured.rowsRead(), rowsWritten: measured.rowsWritten(), statements: measured.statementCount() }));
  return result;
}
