import type { ReadableDatabase } from "../db/types.js";
import {
  COMPLETE_CSV_ENCODING,
  createCompleteExportPlan,
  readCompleteExportPage,
} from "./complete-csv.js";
import type {
  CompleteExportCursor,
  CompleteExportPlan,
  CompleteExportScope,
} from "./complete-csv.js";
import { crc32, zipStream } from "./zip.js";
import type { ZipEntry } from "./zip.js";
import type { CsvExportDownloadJob } from "./service.js";

import { COMPLETE_ARCHIVE_PART_CHUNKS } from "./contracts.js";
const encoder = new TextEncoder();

interface StoredPage {
  next: CompleteExportCursor;
  name: string;
  rows: number;
  crc: number;
  index: number;
  evidence?: {
    sourceKey: string;
    rowid: string;
    offset: number;
    totalBytes: number | null;
    etag: string | null;
    status: "copied" | "unavailable";
  };
}

function planKey(chunkKey: (id: string, index: number) => string, id: string): string {
  return `${chunkKey(id, 0)}.complete-plan.json`;
}

function storedPage(object: R2Object, index: number): StoredPage {
  const value = JSON.parse(object.customMetadata?.complete || "null") as StoredPage | null;
  if (
    !value ||
    value.index !== index ||
    !Number.isSafeInteger(value.next?.table) ||
    value.next.table < 0 ||
    !(value.next.after === null || typeof value.next.after === "string") ||
    !/^(?:[a-zA-Z0-9_]+\/part-\d+\.csv|evidence--?\d+\/(?:part-\d+\.bin|unavailable\.json)|evidence-complete\.json)$/u.test(
      value.name,
    ) ||
    !(
      value.next.offset === undefined ||
      (Number.isSafeInteger(value.next.offset) && value.next.offset >= 0)
    ) ||
    !Number.isSafeInteger(value.rows) ||
    value.rows < 0 ||
    !Number.isInteger(value.crc) ||
    value.crc < 0 ||
    value.crc > 0xffffffff
  ) {
    throw new Error("complete_export_invalid_chunk_metadata");
  }
  return value;
}

async function readPlan(object: R2ObjectBody | null): Promise<CompleteExportPlan> {
  if (!object) throw new Error("complete_export_plan_missing");
  const plan = JSON.parse(await object.text()) as CompleteExportPlan;
  if (
    plan?.version !== 1 ||
    !["active", "all", "catalog"].includes(plan.scope) ||
    !Array.isArray(plan.tables) ||
    !plan.tables.length ||
    plan.tables.some(
      (table) =>
        !/^[a-zA-Z0-9_]+$/u.test(table.name) ||
        typeof table.sql !== "string" ||
        typeof table.key !== "string" ||
        !(table.maxRowid === null || typeof table.maxRowid === "string"),
    )
  ) {
    throw new Error("complete_export_invalid_plan");
  }
  return plan;
}

async function evidencePage(
  db: ReadableDatabase,
  bucket: R2Bucket,
  plan: CompleteExportPlan,
  cursor: CompleteExportCursor,
) {
  const horizon = plan.tables.find((table) => table.name === "evidence_archive")?.maxRowid ?? null;
  const row = await db
    .prepare(`SELECT CAST(_rowid_ AS TEXT) AS rowid, r2_object_key AS sourceKey
    FROM evidence_archive WHERE _rowid_ <= ? ${cursor.after === null ? "" : "AND _rowid_ > ?"}
    ORDER BY _rowid_ LIMIT 1`)
    .bind(...(cursor.after === null ? [horizon] : [horizon, cursor.after]))
    .first<{ rowid: string; sourceKey: string }>();
  if (!row)
    return {
      bytes: encoder.encode("{}"),
      name: "evidence-complete.json",
      rows: 0,
      next: { table: cursor.table + 1, after: null },
    };
  const offset = cursor.offset ?? 0;
  const metadata = await bucket.head(row.sourceKey);
  if (!metadata) {
    if (offset) throw new Error("complete_export_evidence_disappeared");
    const evidence: NonNullable<StoredPage["evidence"]> = {
      ...row,
      offset: 0,
      totalBytes: null,
      etag: null,
      status: "unavailable",
    };
    return {
      bytes: encoder.encode(JSON.stringify(evidence)),
      name: `evidence-${row.rowid}/unavailable.json`,
      rows: 0,
      next: { table: cursor.table, after: row.rowid },
      evidence,
    };
  }
  if (cursor.etag && cursor.etag !== metadata.etag)
    throw new Error("complete_export_evidence_changed");
  const length = Math.min(2 * 1024 * 1024, metadata.size - offset);
  if (length < 0) throw new Error("complete_export_evidence_invalid_offset");
  const object = await bucket.get(row.sourceKey, {
    onlyIf: { etagMatches: metadata.etag },
    ...(length > 0 ? { range: { offset, length } } : {}),
  });
  if (!object || !("body" in object)) throw new Error("complete_export_evidence_changed");
  const bytes = new Uint8Array(await object.arrayBuffer());
  if (bytes.byteLength !== length) throw new Error("complete_export_evidence_invalid_size");
  const nextOffset = offset + length;
  const evidence: NonNullable<StoredPage["evidence"]> = {
    ...row,
    offset,
    totalBytes: metadata.size,
    etag: metadata.etag,
    status: "copied",
  };
  return {
    bytes,
    name: `evidence-${row.rowid}/part-${String(offset).padStart(12, "0")}.bin`,
    rows: 0,
    evidence,
    next:
      nextOffset < metadata.size
        ? { ...cursor, offset: nextOffset, etag: metadata.etag }
        : { table: cursor.table, after: row.rowid },
  };
}

export async function ensureCompleteArchiveChunk(
  db: ReadableDatabase,
  bucket: R2Bucket,
  job: { id: string; scope: CompleteExportScope; maxPrimaryId: number },
  index: number,
  chunkKey: (id: string, index: number) => string,
): Promise<{
  key: string;
  nextAfterId: number;
  rowCount: number;
  byteCount: number;
  hasMore: boolean;
}> {
  const key = chunkKey(job.id, index);
  const definitionKey = planKey(chunkKey, job.id);
  let planObject = await bucket.get(definitionKey);
  if (!planObject && index === 0) {
    const plan = await createCompleteExportPlan(db, job.scope, job.maxPrimaryId);
    await bucket.put(definitionKey, encoder.encode(JSON.stringify(plan)), {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "application/json" },
    });
    planObject = await bucket.get(definitionKey);
  }
  const plan = await readPlan(planObject);
  if (plan.scope !== job.scope) throw new Error("complete_export_scope_mismatch");
  const existing = await bucket.head(key);
  if (existing) {
    const page = storedPage(existing, index);
    return {
      key,
      nextAfterId: index + 1,
      rowCount: page.rows,
      byteCount: existing.size,
      hasMore: page.next.table <= plan.tables.length,
    };
  }
  let cursor: CompleteExportCursor = { table: 0, after: null };
  if (index > 0) {
    const previous = await bucket.head(chunkKey(job.id, index - 1));
    if (!previous) throw new Error("complete_export_predecessor_missing");
    cursor = storedPage(previous, index - 1).next;
  }
  const page =
    cursor.table === plan.tables.length
      ? await evidencePage(db, bucket, plan, cursor)
      : await readCompleteExportPage(db, plan, cursor).then((page) => ({
          ...page,
          name: `${page.filename}/part-${String(index + 1).padStart(8, "0")}.csv`,
          evidence: undefined,
        }));
  const metadata: StoredPage = {
    next: page.next,
    name: page.name,
    rows: page.rows,
    crc: crc32(page.bytes),
    index,
    evidence: page.evidence,
  };
  const object =
    (await bucket.put(key, page.bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "text/csv; charset=utf-8" },
      customMetadata: { complete: JSON.stringify(metadata) },
    })) || (await bucket.head(key));
  if (!object) throw new Error("complete_export_chunk_write_lost");
  const winner = storedPage(object, index);
  return {
    key,
    nextAfterId: index + 1,
    rowCount: winner.rows,
    byteCount: object.size,
    hasMore: winner.next.table <= plan.tables.length,
  };
}

export async function createCompleteArchiveDownloadResponse(
  job: CsvExportDownloadJob,
  bucket: R2Bucket,
  chunkKey: (id: string, index: number) => string,
  filename: string,
  part = 1,
  now = new Date(),
): Promise<Response> {
  const fail = (error: string, status: number) =>
    new Response(JSON.stringify({ error }), {
      status,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  if (job.expiresAt && job.expiresAt <= now.toISOString())
    return fail("complete_export_expired", 410);
  if (job.status !== "ready") return fail("complete_export_not_ready", 409);
  const parts = Math.ceil(job.chunkCount / COMPLETE_ARCHIVE_PART_CHUNKS);
  if (!Number.isSafeInteger(part) || part < 1 || part > parts)
    return fail("complete_export_invalid_part", 400);
  const plan = await readPlan(await bucket.get(planKey(chunkKey, job.id)));
  async function* entries(): AsyncGenerator<ZipEntry> {
    const files: {
      name: string;
      rows: number;
      bytes: number;
      crc32: number;
      evidence?: StoredPage["evidence"];
    }[] = [];
    const start = (part - 1) * COMPLETE_ARCHIVE_PART_CHUNKS;
    const end = Math.min(start + COMPLETE_ARCHIVE_PART_CHUNKS, job.chunkCount);
    for (let index = start; index < end; index += 1) {
      const object = await bucket.get(chunkKey(job.id, index));
      if (!object) throw new Error(`complete_export_chunk_missing:${index}`);
      const page = storedPage(object, index);
      files.push({
        name: page.name,
        rows: page.rows,
        bytes: object.size,
        crc32: page.crc,
        evidence: page.evidence,
      });
      yield { name: page.name, size: object.size, crc: page.crc, body: object.body };
    }
    const bytes = encoder.encode(
      JSON.stringify(
        {
          ...plan,
          jobId: job.id,
          volume: part,
          volumes: parts,
          totalCsvParts: job.chunkCount,
          files,
          encoding: COMPLETE_CSV_ENCODING,
          scopeNote:
            "All product/catalog tables are included as cross-reference context. Only products.csv is filtered for the active scope. No related-table record or column is sampled or truncated.",
        },
        null,
        2,
      ),
    );
    yield {
      name: "manifest.json",
      size: bytes.byteLength,
      crc: crc32(bytes),
      body: new Response(bytes).body!,
    };
  }
  return new Response(zipStream(entries()), {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="${filename.replace(/\.csv$/u, "")}-part-${part}-of-${parts}.zip"`,
      "cache-control": "no-store",
    },
  });
}
