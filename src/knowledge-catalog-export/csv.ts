import {
  KNOWLEDGE_CATALOG_CSV_BOM,
  knowledgeCatalogCsvHeader,
  knowledgeCatalogCsvRow,
} from "../admin/knowledge-catalog-csv.js";
import type { KnowledgeCatalogExportRow } from "../db/knowledge-catalog-export-repository.js";

/** One small, predictable CPU slice per Queue delivery. */
export const KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE = 100;
/** Leaves headroom below the 1,000 internal-subrequest ceiling while downloading. */
export const KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS = 900;
export const KNOWLEDGE_CATALOG_EXPORT_OBJECT_PREFIX = "knowledge-catalog-exports";

export function knowledgeCatalogExportChunkKey(jobId: string, chunkIndex: number): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error("invalid_knowledge_catalog_export_chunk_index");
  }
  return `${KNOWLEDGE_CATALOG_EXPORT_OBJECT_PREFIX}/${jobId}/${String(chunkIndex).padStart(8, "0")}.csv`;
}

/** Encodes one page; only chunk zero carries the UTF-8 BOM and header. */
export function encodeKnowledgeCatalogExportChunk(
  rows: readonly KnowledgeCatalogExportRow[],
  chunkIndex: number,
): Uint8Array {
  const lines = rows.map((row) => knowledgeCatalogCsvRow(row));
  const prefix =
    chunkIndex === 0 ? `${KNOWLEDGE_CATALOG_CSV_BOM}${knowledgeCatalogCsvHeader()}\r\n` : "";
  const contents = `${prefix}${lines.length ? `${lines.join("\r\n")}\r\n` : ""}`;
  return new TextEncoder().encode(contents);
}
