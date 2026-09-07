import {
  ADMIN_WORK_COUNT_LIMIT,
  type AdminDuplicateCountCursor,
  type AdminWorkCountsPage,
} from "../api/admin-work-counts-contract.js";
import { catalogIdentityKey } from "../catalog/knowledge-catalog-identity.js";
import type { ReadableDatabase } from "./types.js";

const DUPLICATE_PAGE_SIZE = 200;

export async function readAdminWorkCounts(
  db: ReadableDatabase,
  cursor: AdminDuplicateCountCursor,
): Promise<AdminWorkCountsPage> {
  // LIMIT belongs inside each COUNT: status indexes stop after 100 work items.
  const counts = await db
    .prepare(`
    SELECT
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM product_correction_reports
        WHERE status IN ('open', 'in_review') LIMIT ?
      )) AS reports,
      (SELECT COUNT(*) FROM (
        SELECT 1 FROM knowledge_catalog_candidates
        WHERE review_status = 'pending' LIMIT ?
      )) AS candidates
  `)
    .bind(ADMIN_WORK_COUNT_LIMIT, ADMIN_WORK_COUNT_LIMIT)
    .all<{ reports: number; candidates: number }>();

  // This projection contains only members of non-singleton SQL buckets. Its keyset range
  // bounds reads even when most of the catalog has no duplicates or one bucket is enormous.
  // Recheck the actual identity rule; a coarse SQL bucket can contain unrelated products.
  const result = await db
    .prepare(`
    SELECT dm.bucket_key, dm.product_id, kp.manufacturer_id, kp.canonical_model
    FROM knowledge_catalog_duplicate_members dm
    JOIN knowledge_catalog_products kp ON kp.id = dm.product_id
    WHERE (dm.bucket_key, dm.product_id) > (?, ?)
    ORDER BY dm.bucket_key, dm.product_id
    LIMIT ?
  `)
    .bind(cursor.bucketKey, cursor.afterId, DUPLICATE_PAGE_SIZE + 1)
    .all<{
      bucket_key: string;
      product_id: number;
      manufacturer_id: string;
      canonical_model: string;
    }>();
  const rows = result.results || [];
  const page = rows.slice(0, DUPLICATE_PAGE_SIZE);
  const last = page.at(-1);
  return {
    reports: Number(counts.results[0].reports),
    candidates: Number(counts.results[0].candidates),
    duplicateIdentities: page.map((row) =>
      catalogIdentityKey(row.manufacturer_id, row.canonical_model),
    ),
    nextDuplicateCursor:
      rows.length > DUPLICATE_PAGE_SIZE && last
        ? { bucketKey: last.bucket_key, afterId: Number(last.product_id) }
        : null,
  };
}
