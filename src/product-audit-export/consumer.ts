import { ensureCompleteArchiveChunk } from "../export/complete-archive.js";
import {
  advanceProductAuditExportJob,
  claimProductAuditExportJob,
  failClaimedProductAuditExportJob,
  failProductAuditExportJob,
  failQueuedProductAuditExportJob,
  getProductAuditExportLeaseExpiry,
  getProductAuditExportJob,
  releaseProductAuditExportJobClaim,
} from "../db/product-audit-export-job-repository.js";
import { listProductAuditExportPage } from "../db/product-audit-export-repository.js";
import {
  encodeProductAuditExportChunk,
  PRODUCT_AUDIT_EXPORT_PAGE_SIZE,
  productAuditExportChunkKey,
} from "./csv.js";
import type { ProductAuditExportJob, ProductAuditExportQueueMessage } from "./types.js";

import { createExportConsumer } from "../export/consumer.js";
import type { DataExportConsumerEnv } from "../export/consumer.js";
import type { StoredDataExportChunk } from "../export/contracts.js";
import { ensureStoredCsvChunk } from "../export/stored-csv-chunk.js";

export type ProductAuditExportConsumerEnv = DataExportConsumerEnv<"product_audit_export">;

async function ensureChunk(
  env: ProductAuditExportConsumerEnv,
  job: ProductAuditExportJob,
  message: ProductAuditExportQueueMessage,
): Promise<StoredDataExportChunk> {
  if (job.format === "complete") {
    return ensureCompleteArchiveChunk(
      env.DB,
      env.EVIDENCE_BUCKET,
      { id: job.id, scope: job.scope, maxPrimaryId: job.maxListingId },
      message.expectedChunkCount,
      productAuditExportChunkKey,
    );
  }
  return ensureStoredCsvChunk(env.EVIDENCE_BUCKET, {
    key: productAuditExportChunkKey(job.id, message.expectedChunkCount),
    kind: "product_audit_export",
    cursor: message,
    maxId: job.maxListingId,
    metadata: { maxListingId: job.maxListingId, scope: job.scope },
    loadPage: () =>
      listProductAuditExportPage(env.DB, {
        scope: job.scope,
        afterId: message.expectedAfterId,
        maxId: job.maxListingId,
        limit: PRODUCT_AUDIT_EXPORT_PAGE_SIZE,
      }),
    rowId: (row) => row.listingId,
    encode: encodeProductAuditExportChunk,
  });
}

export const {
  consumeMessage: consumeProductAuditExportMessage,
  consumeBatch: consumeProductAuditExportBatch,
  consumeDeadLetterBatch: consumeProductAuditExportDeadLetterBatch,
} = createExportConsumer<ProductAuditExportJob, "product_audit_export">({
  kind: "product_audit_export",
  repository: {
    get: getProductAuditExportJob,
    claim: claimProductAuditExportJob,
    advance: advanceProductAuditExportJob,
    release: releaseProductAuditExportJobClaim,
    leaseExpiry: getProductAuditExportLeaseExpiry,
    fail: failProductAuditExportJob,
    failQueued: failQueuedProductAuditExportJob,
    failClaimed: failClaimedProductAuditExportJob,
  },
  ensureChunk,
});
