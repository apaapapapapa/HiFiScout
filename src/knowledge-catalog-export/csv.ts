import {
  KNOWLEDGE_CATALOG_CSV_BOM,
  knowledgeCatalogCsvHeader,
  knowledgeCatalogCsvRow,
} from "../admin/knowledge-catalog-csv.js";
import type { KnowledgeCatalogExportRow } from "../db/knowledge-catalog-export-repository.js";
import {
  CSV_EXPORT_MAX_CHUNKS,
  csvChunkKey,
  encodeCsvChunk,
} from "../export/csv-chunks.js";

/** One small, predictable CPU slice per Queue delivery. */
export const KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE = 100;
/** Leaves headroom below the 1,000 internal-subrequest ceiling while downloading. */
export const KNOWLEDGE_CATALOG_EXPORT_MAX_CHUNKS = CSV_EXPORT_MAX_CHUNKS;
export const KNOWLEDGE_CATALOG_EXPORT_OBJECT_PREFIX = "knowledge-catalog-exports";

export function knowledgeCatalogExportChunkKey(jobId: string, chunkIndex: number): string {
  return csvChunkKey(
    KNOWLEDGE_CATALOG_EXPORT_OBJECT_PREFIX,
    jobId,
    chunkIndex,
    "invalid_knowledge_catalog_export_chunk_index",
  );
}

/** Encodes one page; only chunk zero carries the UTF-8 BOM and header. */
export function encodeKnowledgeCatalogExportChunk(
  rows: readonly KnowledgeCatalogExportRow[],
  chunkIndex: number,
): Uint8Array {
  return encodeCsvChunk(rows, chunkIndex, {
    bom: KNOWLEDGE_CATALOG_CSV_BOM,
    header: knowledgeCatalogCsvHeader,
    row: knowledgeCatalogCsvRow,
  });
}
