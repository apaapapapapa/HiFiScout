import { isDataExportQueueMessage } from "../export/contracts.js";
import type {
  DataExportJob,
  DataExportJobStatus,
  DataExportQueueMessage,
} from "../export/contracts.js";

/** Persisted lifecycle of an asynchronous Knowledge Catalog CSV job. */
export type KnowledgeCatalogExportJobStatus = DataExportJobStatus;

/**
 * Public job representation shared by the main Worker and the Access-protected admin Worker.
 *
 * `maxCatalogProductId` is a finite ID horizon captured at creation. `expiresAt` is the 24-hour
 * generation deadline while active and the artifact/diagnostic expiry after completion.
 */
export interface KnowledgeCatalogExportJob extends DataExportJob {
  maxCatalogProductId: number;
  expiresAt: string;
}

/** Each delivery names the exact cursor state it is allowed to advance. */
export type KnowledgeCatalogExportQueueMessage = DataExportQueueMessage<"knowledge_catalog_export">;

export function isKnowledgeCatalogExportQueueMessage(
  value: unknown,
): value is KnowledgeCatalogExportQueueMessage {
  return isDataExportQueueMessage(value, "knowledge_catalog_export");
}
