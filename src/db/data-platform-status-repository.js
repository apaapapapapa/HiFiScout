function firstRow(result) {
  return result?.results?.[0] || {};
}

export async function dataPlatformStatus(db) {
  const results = await db.batch([
    db.prepare(`
      SELECT COUNT(*) AS product_count,
             SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_product_count
      FROM products
    `),
    db.prepare("SELECT COUNT(*) AS price_history_count FROM price_history"),
    db.prepare(`
      SELECT COUNT(*) AS knowledge_catalog_count,
             SUM(CASE WHEN verification_status = 'verified' THEN 1 ELSE 0 END) AS verified_knowledge_catalog_count
      FROM knowledge_catalog_products
    `),
    db.prepare(`
      SELECT COUNT(*) AS identity_resolution_count,
             SUM(CASE WHEN status = 'matched' THEN 1 ELSE 0 END) AS identity_matched_count,
             SUM(CASE WHEN status = 'unresolved' THEN 1 ELSE 0 END) AS identity_unresolved_count,
             SUM(CASE WHEN match_method = 'vetoed' THEN 1 ELSE 0 END) AS identity_veto_count
      FROM product_identity_resolutions
    `),
    db.prepare("SELECT COUNT(*) AS evidence_metadata_count FROM evidence_archive"),
    db.prepare(`
      SELECT COUNT(*) AS crawl_runs_24h
      FROM crawl_runs
      WHERE started_at >= strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-24 hours')
    `),
  ]);

  const products = firstRow(results[0]);
  const history = firstRow(results[1]);
  const catalog = firstRow(results[2]);
  const identity = firstRow(results[3]);
  const evidence = firstRow(results[4]);
  const crawl = firstRow(results[5]);
  const number = (value) => Number(value || 0);

  return {
    checkedAt: new Date().toISOString(),
    structuredUsage: {
      productCount: number(products.product_count),
      activeProductCount: number(products.active_product_count),
      priceHistoryCount: number(history.price_history_count),
      knowledgeCatalogCount: number(catalog.knowledge_catalog_count),
      verifiedKnowledgeCatalogCount: number(catalog.verified_knowledge_catalog_count),
      identityResolutionCount: number(identity.identity_resolution_count),
      identityMatchedCount: number(identity.identity_matched_count),
      identityUnresolvedCount: number(identity.identity_unresolved_count),
      identityVetoCount: number(identity.identity_veto_count),
      evidenceMetadataCount: number(evidence.evidence_metadata_count),
      crawlRuns24h: number(crawl.crawl_runs_24h),
    },
    platformMetrics: {
      source: "cloudflare_native",
      trackedExternally: [
        "database_size",
        "read_write_query_volume",
        "rows_read_written",
        "query_latency",
        "d1_error_rate",
        "d1_overloaded_timeout_errors",
      ],
    },
  };
}
