import {
  PRODUCT_AUDIT_CSV_BOM,
  productAuditCsvHeader,
  productAuditCsvRow,
} from "../admin/product-audit-csv.js";
import type { ProductAuditExportRow } from "../db/product-audit-export-repository.js";
import { CSV_EXPORT_MAX_CHUNKS, csvChunkKey, encodeCsvChunk } from "../export/csv-chunks.js";

/** Deliberately small so each Queue delivery has a predictable, low CPU ceiling. */
export const PRODUCT_AUDIT_EXPORT_PAGE_SIZE = 250;
/** Leaves headroom below the Free-plan 1,000 internal-subrequest ceiling at download time. */
export const PRODUCT_AUDIT_EXPORT_MAX_CHUNKS = CSV_EXPORT_MAX_CHUNKS;
export const PRODUCT_AUDIT_EXPORT_OBJECT_PREFIX = "product-audit-exports";

export function productAuditExportChunkKey(jobId: string, chunkIndex: number): string {
  return csvChunkKey(
    PRODUCT_AUDIT_EXPORT_OBJECT_PREFIX,
    jobId,
    chunkIndex,
    "invalid_product_audit_export_chunk_index",
  );
}

/** Encodes at most one page; only chunk zero carries the UTF-8 BOM and header. */
export function encodeProductAuditExportChunk(
  rows: readonly ProductAuditExportRow[],
  chunkIndex: number,
): Uint8Array {
  return encodeCsvChunk(rows, chunkIndex, {
    bom: PRODUCT_AUDIT_CSV_BOM,
    header: productAuditCsvHeader,
    row: productAuditCsvRow,
  });
}
