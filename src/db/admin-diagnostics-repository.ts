import type { AdminListingDiagnosis } from "../api/admin-listing-contracts.js";
import type { ReadableDatabase } from "./types.js";

/** Only primary-key joins: opening the inspector never resolves or repairs an identity. */
export const ADMIN_LISTING_DIAGNOSIS_SQL = `SELECT json_object(
  'listingId', p.id, 'observedAt', p.last_seen_at,
  'seller', json_object('title', p.title, 'manufacturer', p.raw_manufacturer,
    'model', p.raw_model, 'category', p.raw_category, 'url', p.source_url),
  'decision', json_object('manufacturerId', p.canonical_manufacturer_id,
    'manufacturer', p.manufacturer, 'manufacturerStatus', p.manufacturer_resolution_status,
    'manufacturerMethod', p.manufacturer_resolution_method,
    'manufacturerConfidence', p.manufacturer_resolution_confidence,
    'model', p.model, 'normalizedModel', p.normalized_model,
    'modelStatus', p.model_resolution_status, 'modelMethod', p.model_resolution_method,
    'modelConfidence', p.model_resolution_confidence, 'category', p.category,
    'categoryId', p.primary_category_id, 'categoryStatus', p.classification_status,
    'color', p.presentation_color),
  'overrides', json_object('メーカー', o.manufacturer_id, '型番', o.model,
    'カテゴリ', o.primary_category_id, '色', o.presentation_color),
  'identity', json_object('status', r.status, 'method', r.match_method,
    'confidence', r.confidence, 'matchedFields', COALESCE(r.matched_fields_json, '[]'),
    'rejectedBy', COALESCE(r.rejected_by_json, '[]'), 'evaluatedAt', r.evaluated_at,
    'catalogId', r.catalog_product_id, 'catalogName', c.canonical_name,
    'candidateId', r.candidate_catalog_product_id, 'candidateName', candidate.canonical_name),
  'search', json_object('key', e.entity_key, 'kind', e.entity_kind, 'model', e.model,
    'categoryId', e.primary_category_id, 'offerCount', e.offer_count,
    'pending', (p.remediation_projection_required = 1
      OR EXISTS (SELECT 1 FROM listing_projection_pending lp WHERE lp.listing_product_id = p.id)
      OR EXISTS (SELECT 1 FROM product_search_catalog_pending cp WHERE cp.listing_product_id = p.id)),
    'active', p.is_active)
) AS snapshot
FROM products p
LEFT JOIN product_admin_overrides o ON o.listing_product_id = p.id
LEFT JOIN product_identity_resolutions r ON r.listing_product_id = p.id
LEFT JOIN knowledge_catalog_products c ON c.id = r.catalog_product_id
LEFT JOIN knowledge_catalog_products candidate ON candidate.id = r.candidate_catalog_product_id
LEFT JOIN product_search_entity_offers m ON m.listing_product_id = p.id
LEFT JOIN product_search_entities e ON e.id = m.entity_id
WHERE p.id = ?`;

export const ADMIN_IDENTITY_PEERS_SQL = `SELECT p.id, p.shop_key AS shop,
  p.primary_category_id AS category, p.model_resolution_status AS modelStatus,
  e.entity_key AS entityKey
FROM products p INDEXED BY idx_products_exact_identity
LEFT JOIN product_search_entity_offers m ON m.listing_product_id = p.id
LEFT JOIN product_search_entities e ON e.id = m.entity_id
WHERE p.canonical_manufacturer_id = ? AND p.normalized_model = ? AND p.is_active = 1
  AND COALESCE(p.canonical_manufacturer_id, '') <> '' AND COALESCE(p.normalized_model, '') <> ''
ORDER BY p.model_resolution_status, p.id LIMIT 21`;

export async function readAdminListingDiagnosis(
  db: ReadableDatabase,
  listingId: number,
): Promise<AdminListingDiagnosis | null> {
  if (!Number.isSafeInteger(listingId) || listingId < 1) throw new Error("invalid_listing_id");
  const row = await db
    .prepare(ADMIN_LISTING_DIAGNOSIS_SQL)
    .bind(listingId)
    .first<{ snapshot: string }>();
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot) as AdminListingDiagnosis;
  const { manufacturerId, normalizedModel } = snapshot.decision;
  const peers =
    manufacturerId && normalizedModel
      ? ((
          await db
            .prepare(ADMIN_IDENTITY_PEERS_SQL)
            .bind(manufacturerId, normalizedModel)
            .all<AdminListingDiagnosis["peers"][number]>()
        ).results ?? [])
      : [];
  return { ...snapshot, peers: peers.slice(0, 20), peersHasMore: peers.length > 20 };
}
