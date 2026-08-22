export const CSV_EXPORT_MAX_CHUNKS = 900;

export interface CsvChunkCodec<T> {
  readonly bom: string;
  readonly header: () => string;
  readonly row: (value: T) => string;
}

export function csvChunkKey(
  objectPrefix: string,
  jobId: string,
  chunkIndex: number,
  invalidChunkIndexError: string,
): string {
  if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0) {
    throw new Error(invalidChunkIndexError);
  }
  return `${objectPrefix}/${jobId}/${String(chunkIndex).padStart(8, "0")}.csv`;
}

export function encodeCsvChunk<T>(
  rows: readonly T[],
  chunkIndex: number,
  codec: CsvChunkCodec<T>,
): Uint8Array {
  const lines = rows.map((row) => codec.row(row));
  const prefix = chunkIndex === 0 ? `${codec.bom}${codec.header()}\r\n` : "";
  const contents = `${prefix}${lines.length ? `${lines.join("\r\n")}\r\n` : ""}`;
  return new TextEncoder().encode(contents);
}
