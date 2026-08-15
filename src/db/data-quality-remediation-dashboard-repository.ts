import { REMEDIATION_DASHBOARD_LIMITS } from "../data-quality/remediation-dashboard.js";
import type { QueryableDatabase } from "./types.js";

interface IdentityMethodRow {
  status: string;
  match_method: string;
  listing_count: number;
  shop_count: number;
}

export async function listIdentityResolutionMethodDistribution(db: QueryableDatabase) {
  const result = await db
    .prepare(`
      SELECT COALESCE(r.status, 'missing') AS status,
             COALESCE(NULLIF(r.match_method, ''), 'missing') AS match_method,
             COUNT(DISTINCT p.id) AS listing_count,
             COUNT(DISTINCT p.shop_key) AS shop_count
      FROM products p
      LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
      WHERE p.is_active = 1
      GROUP BY COALESCE(r.status, 'missing'), COALESCE(NULLIF(r.match_method, ''), 'missing')
      ORDER BY listing_count DESC, status, match_method
      LIMIT ?
    `)
    .bind(REMEDIATION_DASHBOARD_LIMITS.identityMethods)
    .all<IdentityMethodRow>();
  return (result.results || []).map((row) => ({
    status: row.status || "missing",
    method: row.match_method || "missing",
    listingCount: Number(row.listing_count || 0),
    shopCount: Number(row.shop_count || 0),
  }));
}
