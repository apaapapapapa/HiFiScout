import {
  PRODUCT_AUDIT_CSV_BOM,
  productAuditCsvHeader,
  productAuditCsvRow,
} from "../admin/product-audit-csv.js";
import type { ProductAuditExportRow } from "../db/product-audit-export-repository.js";

/** Deliberately small so each Queue delivery has a predictable, low CPU ceiling. */
export const PRODUCT_AUDIT_EXPORT_PAGE_SIZE = 250;
/** Leaves headroom below the Free-plan 1,000 internal-subrequest ceiling at download time. */
export const PRODUCT_AUDIT_EXPORT_MAX_CHUNKS = 900;
export const PRODUCT_AUDIT_EXPORT_OBJECT_PREFIX = "product-audit-exports";

export function productAuditExportChunkKey(jobId: string, chunkIndex: number): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("invalid_product_audit_export_chunk_index");
  }
  return `${PRODUCT_AUDIT_EXPORT_OBJECT_PREFIX}/${jobId}/${String(chunkIndex).padStart(8, "0")}.csv`;
}

/** Encodes at most one page; only chunk zero carries the UTF-8 BOM and header. */
export function encodeProductAuditExportChunk(
  rows: readonly ProductAuditExportRow[],
  chunkIndex: number,
): Uint8Array {
  const lines = rows.map((row) => productAuditCsvRow(row));
  const prefix = chunkIndex === 0 ? `${PRODUCT_AUDIT_CSV_BOM}${productAuditCsvHeader()}\r\n` : "";
  const contents = `${prefix}${lines.length ? `${lines.join("\r\n")}\r\n` : ""}`;
  return new TextEncoder().encode(contents);
}
