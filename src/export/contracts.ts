/** One volume stays below the Worker's R2 subrequest ceiling; the whole export has no row cap. */
export const COMPLETE_ARCHIVE_PART_CHUNKS = 200;
export type DataExportFormat = "csv" | "complete";

export type DataExportKind = "product_audit_export" | "knowledge_catalog_export";
export type DataExportJobStatus = "queued" | "processing" | "ready" | "failed";

export interface DataExportCursor {
  afterId: number;
  chunkCount: number;
}

/** The state needed to fence and advance one bounded export delivery. */
export interface DataExportJob extends DataExportCursor {
  id: string;
  status: DataExportJobStatus;
  /** Legacy CSVs remain readable; complete jobs use chunk sequence as afterId. */
  format?: DataExportFormat;
  archivePartCount?: number;
  rowCount: number;
  byteCount: number;
  deliveryAttempts: number;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  expiresAt: string | null;
  error: string;
}

export interface DataExportQueueMessage<Kind extends DataExportKind = DataExportKind> {
  kind: Kind;
  jobId: string;
  expectedAfterId: number;
  expectedChunkCount: number;
}

export interface ClaimedDataExportJob<Job extends DataExportJob> {
  job: Job;
  leaseToken: string;
  leaseExpiresAt: string;
}

export interface AdvanceDataExportJobInput {
  jobId: string;
  leaseToken: string;
  expectedAfterId: number;
  expectedChunkCount: number;
  nextAfterId: number;
  addedRows: number;
  addedBytes: number;
  hasMore: boolean;
  advancedAt: Date;
}

export interface StoredDataExportChunk {
  key: string;
  nextAfterId: number;
  rowCount: number;
  byteCount: number;
  hasMore: boolean;
}
export function isDataExportQueueMessage<Kind extends DataExportKind>(
  value: unknown,
  kind: Kind,
): value is DataExportQueueMessage<Kind> {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.kind === kind &&
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
