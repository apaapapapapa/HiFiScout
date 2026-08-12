import { getMaintenanceSettings } from "./config.js";

function cutoffIso(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

export function retentionCutoffs(env, now = new Date()) {
  const settings = getMaintenanceSettings(env);
  return {
    settings,
    crawlRunsBefore: cutoffIso(now, settings.crawlRunRetentionDays),
    priceHistoryBefore: cutoffIso(now, settings.priceHistoryRetentionDays),
    inactiveProductsBefore: cutoffIso(now, settings.inactiveProductRetentionDays),
  };
}

function changes(result) {
  return Number(result?.meta?.changes || 0);
}

export async function runRetentionCleanup(env, { now = new Date() } = {}) {
  const { settings, crawlRunsBefore, priceHistoryBefore, inactiveProductsBefore } =
    retentionCutoffs(env, now);
  const limit = settings.deleteBatchSize;

  const crawlRuns = await env.DB.prepare(`
    DELETE FROM crawl_runs
    WHERE id IN (
      SELECT id FROM crawl_runs WHERE started_at < ? ORDER BY started_at ASC LIMIT ?
    )
  `)
    .bind(crawlRunsBefore, limit)
    .run();

  const priceHistory = await env.DB.prepare(`
    DELETE FROM price_history
    WHERE id IN (
      SELECT id FROM price_history WHERE observed_at < ? ORDER BY observed_at ASC LIMIT ?
    )
  `)
    .bind(priceHistoryBefore, limit)
    .run();

  const inactiveProducts = await env.DB.prepare(`
    DELETE FROM products
    WHERE id IN (
      SELECT id FROM products
      WHERE is_active = 0 AND last_seen_at < ?
      ORDER BY last_seen_at ASC
      LIMIT ?
    )
  `)
    .bind(inactiveProductsBefore, limit)
    .run();

  const result = {
    event: "retention_cleanup",
    at: now.toISOString(),
    deleted: {
      crawlRuns: changes(crawlRuns),
      priceHistory: changes(priceHistory),
      inactiveProducts: changes(inactiveProducts),
    },
  };
  console.log(JSON.stringify(result));
  return result;
}
