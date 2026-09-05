/** Persisted lifecycle of an asynchronous Knowledge Catalog CSV job. */
export type KnowledgeCatalogExportJobStatus = "queued" | "processing" | "ready" | "failed";

/**
 * Public job representation shared by the main Worker and the Access-protected admin Worker.
 *
 * `maxCatalogProductId` is a finite ID horizon captured at creation. `expiresAt` is the 24-hour
 * generation deadline while active and the artifact/diagnostic expiry after completion.
 */
export interface KnowledgeCatalogExportJob {
  /** Legacy CSVs remain readable; complete jobs use chunk sequence as afterId. */
  format?: "csv" | "complete";
  archivePartCount?: number;
  id: string;
  status: KnowledgeCatalogExportJobStatus;
  maxCatalogProductId: number;
  afterId: number;
  chunkCount: number;
  rowCount: number;
  byteCount: number;
  deliveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string;
  error: string;
}

/** Each delivery names the exact cursor state it is allowed to advance. */
export interface KnowledgeCatalogExportQueueMessage {
  kind: "knowledge_catalog_export";
  jobId: string;
  expectedAfterId: number;
  expectedChunkCount: number;
}

export function isKnowledgeCatalogExportQueueMessage(
  value: unknown,
): value is KnowledgeCatalogExportQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === "knowledge_catalog_export" &&
    typeof message.jobId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      message.jobId,
    ) &&
    Number.isSafeInteger(message.expectedAfterId) &&
    Number(message.expectedAfterId) >= 0 &&
    Number.isSafeInteger(message.expectedChunkCount) &&
    Number(message.expectedChunkCount) >= 0
  );
}
