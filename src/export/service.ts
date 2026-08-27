export interface CsvExportDownloadJob {
  readonly id: string;
  readonly status: string;
  readonly expiresAt: string | null;
  readonly chunkCount: number;
  readonly byteCount: number;
}

interface CsvExportDownloadOptions<T extends CsvExportDownloadJob> {
  readonly errorPrefix: string;
  readonly maxChunks: number;
  readonly chunkKey: (jobId: string, chunkIndex: number) => string;
  readonly filename: (job: T) => string;
}

export function exportEnqueueIsStale(updatedAt: string, now: Date, staleSeconds: number): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  return !Number.isFinite(updatedAtMs) || updatedAtMs <= now.getTime() - staleSeconds * 1000;
}

function jsonError(error: string, status: number): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function byteStreamFromChunks(
  bucket: R2Bucket,
  jobId: string,
  chunkCount: number,
  firstObject: R2ObjectBody,
  chunkKey: (jobId: string, chunkIndex: number) => string,
  errorPrefix: string,
): ReadableStream<Uint8Array> {
  let chunkIndex = 0;
  let object: R2ObjectBody | null = firstObject;
  let reader: ReadableStreamDefaultReader | null = null;

  return new ReadableStream<Uint8Array>({
    type: "bytes",
    async pull(controller): Promise<void> {
      try {
        for (;;) {
          if (!reader) {
            if (chunkIndex >= chunkCount) {
              controller.close();
              return;
            }
            object ||= await bucket.get(chunkKey(jobId, chunkIndex));
            if (!object) throw new Error(`${errorPrefix}_chunk_missing:${chunkIndex}`);
            reader = object.body.getReader();
          }

          const result = await reader.read();
          if (!result.done) {
            if (!(result.value instanceof Uint8Array)) {
              throw new Error(`${errorPrefix}_chunk_not_bytes:${chunkIndex}`);
            }
            const bytes = new Uint8Array(new ArrayBuffer(result.value.byteLength));
            bytes.set(result.value);
            controller.enqueue(bytes);
            return;
          }

          reader.releaseLock();
          reader = null;
          object = null;
          chunkIndex += 1;
        }
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason): Promise<void> {
      if (reader) await reader.cancel(reason);
    },
  });
}

/** Streams deterministic R2 CSV chunks without concatenating the attachment in Worker memory. */
export async function createCsvExportDownloadResponse<T extends CsvExportDownloadJob>(
  job: T | null,
  bucket: R2Bucket,
  options: CsvExportDownloadOptions<T>,
  now: Date = new Date(),
): Promise<Response> {
  const { errorPrefix } = options;
  if (!job) return jsonError(`${errorPrefix}_not_found`, 404);
  if (job.expiresAt && job.expiresAt <= now.toISOString()) {
    return jsonError(`${errorPrefix}_expired`, 410);
  }
  if (job.status !== "ready") {
    return jsonError(`${errorPrefix}_${job.status === "failed" ? "failed" : "not_ready"}`, 409);
  }
  if (job.chunkCount < 1) return jsonError(`${errorPrefix}_chunks_missing`, 503);
  if (job.chunkCount > options.maxChunks) {
    return jsonError(`${errorPrefix}_too_many_chunks`, 503);
  }

  const firstObject = await bucket.get(options.chunkKey(job.id, 0));
  if (!firstObject) return jsonError(`${errorPrefix}_chunks_missing`, 503);

  return new Response(
    byteStreamFromChunks(
      bucket,
      job.id,
      job.chunkCount,
      firstObject,
      options.chunkKey,
      errorPrefix,
    ),
    {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${options.filename(job)}"`,
        "content-length": String(job.byteCount),
        "cache-control": "no-store",
      },
    },
  );
}
