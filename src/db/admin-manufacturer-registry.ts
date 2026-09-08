import type { ManufacturerAliasEvidence } from "../catalog/types.js";
import type { ReadableDatabase } from "./types.js";

/** Bound reference-data reads before joining or filtering; never walk the product catalog. */
export async function readAdminManufacturerAliases(
  db: ReadableDatabase,
): Promise<ManufacturerAliasEvidence[]> {
  const result = await db
    .prepare(`WITH alias_page AS MATERIALIZED (
    SELECT manufacturer_id,alias,normalized_alias,verification_status,source,rule_version,'' AS shopKey
      FROM knowledge_catalog_manufacturer_aliases ORDER BY id LIMIT 1001
  ), shop_page AS MATERIALIZED (
    SELECT manufacturer_id,alias,normalized_alias,verification_status,source,rule_version,shop_key AS shopKey
      FROM knowledge_catalog_shop_manufacturer_aliases ORDER BY id LIMIT 1001
  ), bounded_aliases AS (SELECT * FROM alias_page UNION ALL SELECT * FROM shop_page) SELECT a.manufacturer_id AS manufacturerId, m.canonical_name AS canonicalName, a.alias,
    a.normalized_alias AS normalizedAlias, a.verification_status AS verificationStatus,
    a.source, a.rule_version AS ruleVersion, a.shopKey, m.verification_status AS manufacturerStatus
    FROM bounded_aliases a LEFT JOIN knowledge_catalog_manufacturers m ON m.id=a.manufacturer_id`)
    .all<ManufacturerAliasEvidence & { manufacturerStatus: string }>();
  if (result.results.length > 1000)
    throw new Error("別名辞書がプレビュー上限を超えています。対象を限定する必要があります。");
  return result.results
    .filter(
      (row) =>
        row.manufacturerStatus === "verified" &&
        (row.verificationStatus !== "rejected" || row.source === "admin_alias_control"),
    )
    .map(({ manufacturerStatus: _status, ...row }) => row);
}
