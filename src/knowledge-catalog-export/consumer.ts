import { ensureCompleteArchiveChunk } from "../export/complete-archive.js";
import {
  advanceKnowledgeCatalogExportJob,
  claimKnowledgeCatalogExportJob,
  failClaimedKnowledgeCatalogExportJob,
  failKnowledgeCatalogExportJob,
  failQueuedKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportJob,
  getKnowledgeCatalogExportLeaseExpiry,
  releaseKnowledgeCatalogExportJobClaim,
} from "../db/knowledge-catalog-export-job-repository.js";
import { listKnowledgeCatalogExportPage } from "../db/knowledge-catalog-export-repository.js";
import {
  encodeKnowledgeCatalogExportChunk,
  KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE,
  knowledgeCatalogExportChunkKey,
} from "./csv.js";
import type { KnowledgeCatalogExportJob, KnowledgeCatalogExportQueueMessage } from "./types.js";

import { createExportConsumer } from "../export/consumer.js";
import type { DataExportConsumerEnv } from "../export/consumer.js";
import type { StoredDataExportChunk } from "../export/contracts.js";
import { ensureStoredCsvChunk } from "../export/stored-csv-chunk.js";

export type KnowledgeCatalogExportConsumerEnv = DataExportConsumerEnv<"knowledge_catalog_export">;

async function ensureChunk(
  env: KnowledgeCatalogExportConsumerEnv,
  job: KnowledgeCatalogExportJob,
  message: KnowledgeCatalogExportQueueMessage,
): Promise<StoredDataExportChunk> {
  if (job.format === "complete") {
    return ensureCompleteArchiveChunk(
      env.DB,
      env.EVIDENCE_BUCKET,
      { id: job.id, scope: "catalog", maxPrimaryId: job.maxCatalogProductId },
      message.expectedChunkCount,
      knowledgeCatalogExportChunkKey,
    );
  }
  return ensureStoredCsvChunk(env.EVIDENCE_BUCKET, {
    key: knowledgeCatalogExportChunkKey(job.id, message.expectedChunkCount),
    kind: "knowledge_catalog_export",
    cursor: message,
    maxId: job.maxCatalogProductId,
    metadata: { maxCatalogProductId: job.maxCatalogProductId },
    loadPage: () =>
      listKnowledgeCatalogExportPage(env.DB, {
        afterId: message.expectedAfterId,
        maxId: job.maxCatalogProductId,
        limit: KNOWLEDGE_CATALOG_EXPORT_PAGE_SIZE,
      }),
    rowId: (row) => row.catalogProductId,
    encode: encodeKnowledgeCatalogExportChunk,
  });
}

export const {
  consumeMessage: consumeKnowledgeCatalogExportMessage,
  consumeBatch: consumeKnowledgeCatalogExportBatch,
  consumeDeadLetterBatch: consumeKnowledgeCatalogExportDeadLetterBatch,
} = createExportConsumer<KnowledgeCatalogExportJob, "knowledge_catalog_export">({
  kind: "knowledge_catalog_export",
  repository: {
    get: getKnowledgeCatalogExportJob,
    claim: claimKnowledgeCatalogExportJob,
    advance: advanceKnowledgeCatalogExportJob,
    release: releaseKnowledgeCatalogExportJobClaim,
    leaseExpiry: getKnowledgeCatalogExportLeaseExpiry,
    fail: failKnowledgeCatalogExportJob,
    failQueued: failQueuedKnowledgeCatalogExportJob,
    failClaimed: failClaimedKnowledgeCatalogExportJob,
  },
  ensureChunk,
});
