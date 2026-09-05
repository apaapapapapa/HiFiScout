/** Scope captured when a product-audit CSV job is created. */
export type ProductAuditExportScope = "active" | "all";

/** Persisted lifecycle of an asynchronous product-audit CSV job. */
export type ProductAuditExportJobStatus = "queued" | "processing" | "ready" | "failed";

/**
 * Public job representation shared by the main Worker and the Access-protected admin Worker.
 *
 * `maxListingId` is a finite ID horizon fixed when the job is created, while `afterId` and the
 * counters advance only after a complete R2 chunk has been written. `expiresAt` is initially the
 * generation deadline, then becomes the terminal artifact/diagnostic expiry.
 */
export interface ProductAuditExportJob {
  /** Legacy CSVs remain readable; complete jobs use chunk sequence as afterId. */
  format?: "csv" | "complete";
  archivePartCount?: number;
  id: string;
  scope: ProductAuditExportScope;
  status: ProductAuditExportJobStatus;
  maxListingId: number;
  afterId: number;
  chunkCount: number;
  rowCount: number;
  byteCount: number;
  deliveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  error: string;
}

/**
 * Every delivery names the exact cursor state it is allowed to advance.
 *
 * The compare-and-swap fields make duplicate and out-of-order Queue deliveries harmless.
 */
export interface ProductAuditExportQueueMessage {
  kind: "product_audit_export";
  jobId: string;
  expectedAfterId: number;
  expectedChunkCount: number;
}

export function isProductAuditExportQueueMessage(
  value: unknown,
): value is ProductAuditExportQueueMessage {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === "product_audit_export" &&
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
