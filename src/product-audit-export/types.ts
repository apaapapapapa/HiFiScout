import { isDataExportQueueMessage } from "../export/contracts.js";
import type {
  DataExportJob,
  DataExportJobStatus,
  DataExportQueueMessage,
} from "../export/contracts.js";

/** Scope captured when a product-audit CSV job is created. */
export type ProductAuditExportScope = "active" | "all";

/** Persisted lifecycle of an asynchronous product-audit CSV job. */
export type ProductAuditExportJobStatus = DataExportJobStatus;

/**
 * Public job representation shared by the main Worker and the Access-protected admin Worker.
 *
 * `maxListingId` is a finite ID horizon fixed when the job is created, while `afterId` and the
 * counters advance only after a complete R2 chunk has been written. `expiresAt` is initially the
 * generation deadline, then becomes the terminal artifact/diagnostic expiry.
 */
export interface ProductAuditExportJob extends DataExportJob {
  scope: ProductAuditExportScope;
  maxListingId: number;
}

/**
 * Every delivery names the exact cursor state it is allowed to advance.
 *
 * The compare-and-swap fields make duplicate and out-of-order Queue deliveries harmless.
 */
export type ProductAuditExportQueueMessage = DataExportQueueMessage<"product_audit_export">;

export function isProductAuditExportQueueMessage(
  value: unknown,
): value is ProductAuditExportQueueMessage {
  return isDataExportQueueMessage(value, "product_audit_export");
}
