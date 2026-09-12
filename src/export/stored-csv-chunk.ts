import type { DataExportQueueMessage, StoredDataExportChunk } from "./contracts.js";

const CHUNK_METADATA_VERSION = "1";

interface CsvChunkOptions<Row> {
  key: string;
  kind: DataExportQueueMessage["kind"];
  cursor: Pick<DataExportQueueMessage, "expectedAfterId" | "expectedChunkCount">;
  maxId: number;
  /** Keep each export's persisted horizon/scope keys compatible with in-flight jobs. */
  metadata: Record<string, string | number>;
  loadPage: () => Promise<{ items: Row[]; nextAfterId: number | null }>;
  rowId: (row: Row) => number;
  encode: (rows: Row[], chunkIndex: number) => Uint8Array;
}

function integerMetadata(metadata: Record<string, string>, key: string): number | null {
  const value = Number(metadata[key]);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function storedChunkFromObject<Row>(
  object: R2Object,
  options: CsvChunkOptions<Row>,
): StoredDataExportChunk {
  const metadata = object.customMetadata || {};
  const { cursor, maxId } = options;
  const nextAfterId = integerMetadata(metadata, "nextAfterId");
  const rowCount = integerMetadata(metadata, "rowCount");
  const hasMore = metadata.hasMore === "1";
  if (
    metadata.version !== CHUNK_METADATA_VERSION ||
    integerMetadata(metadata, "afterId") !== cursor.expectedAfterId ||
    integerMetadata(metadata, "chunkIndex") !== cursor.expectedChunkCount ||
    Object.entries(options.metadata).some(
      ([key, value]) =>
        (typeof value === "number" ? integerMetadata(metadata, key) : metadata[key]) !== value,
    ) ||
    nextAfterId === null ||
    rowCount === null ||
    (metadata.hasMore !== "0" && metadata.hasMore !== "1") ||
    (hasMore && nextAfterId <= cursor.expectedAfterId) ||
    nextAfterId > maxId
  ) {
    throw new Error(`${options.kind}_chunk_metadata_invalid:${object.key}`);
  }
  return { key: object.key, nextAfterId, rowCount, byteCount: object.size, hasMore };
}

/** Writes or reuses exactly one bounded page; a retry never rereads a committed CSV page. */
export async function ensureStoredCsvChunk<Row>(
  bucket: Pick<R2Bucket, "head" | "put">,
  options: CsvChunkOptions<Row>,
): Promise<StoredDataExportChunk> {
  const { key, cursor, maxId } = options;
  const existing = await bucket.head(key);
  if (existing) return storedChunkFromObject(existing, options);

  const page = await options.loadPage();
  const lastRow = page.items.at(-1);
  const hasMore = page.nextAfterId !== null;
  const nextAfterId =
    page.nextAfterId ?? (lastRow ? options.rowId(lastRow) : cursor.expectedAfterId);
  if (
    nextAfterId < cursor.expectedAfterId ||
    nextAfterId > maxId ||
    (hasMore && nextAfterId <= cursor.expectedAfterId)
  ) {
    throw new Error(`${options.kind}_cursor_did_not_advance`);
  }

  const bytes = options.encode(page.items, cursor.expectedChunkCount);
  const object = await bucket.put(key, bytes, {
    // An expired claimant must not overwrite a chunk committed by another worker.
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "text/csv; charset=utf-8" },
    customMetadata: {
      version: CHUNK_METADATA_VERSION,
      ...Object.fromEntries(
        Object.entries(options.metadata).map(([name, value]) => [name, String(value)]),
      ),
      afterId: String(cursor.expectedAfterId),
      chunkIndex: String(cursor.expectedChunkCount),
      nextAfterId: String(nextAfterId),
      rowCount: String(page.items.length),
      hasMore: hasMore ? "1" : "0",
    },
  });
  if (object) {
    return { key, nextAfterId, rowCount: page.items.length, byteCount: object.size, hasMore };
  }

  // A conditional-write loser adopts the winner's cursor even if the source rows changed.
  const winner = await bucket.head(key);
  if (!winner) throw new Error(`${options.kind}_chunk_write_lost:${key}`);
  return storedChunkFromObject(winner, options);
}
