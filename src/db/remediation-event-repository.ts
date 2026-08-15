/**
 * Before/after provenance for remediation-induced canonical changes.
 *
 * Only actual changes are recorded. An idempotent replay that re-derives the same values writes
 * nothing, so the table stays proportional to how much data actually improved rather than to how
 * often replay ran.
 */

import type { QueryableDatabase, ReadableDatabase } from "./types.js";

export type RemediationField = "manufacturer" | "model" | "category" | "identity";

export interface RemediationEvent {
  listingProductId: number;
  shopKey: string;
  sourceId: string;
  field: RemediationField;
  previousValue: string;
  newValue: string;
  reason: string;
  resolverMethod?: string;
  resolverConfidence?: string;
  resolverVersion?: number;
  processedAt: string;
}

interface RemediationEventRow {
  id: number;
  listing_product_id: number;
  shop_key: string;
  source_id: string;
  field: RemediationField;
  previous_value: string;
  new_value: string;
  reason: string;
  resolver_method: string;
  resolver_confidence: string;
  resolver_version: number;
  processed_at: string;
}

const VALUE_LIMIT = 300;

function text(value: unknown, limit = VALUE_LIMIT): string {
  return String(value ?? "").slice(0, limit);
}

/** Statement form so provenance joins the same bounded batch as the write it explains. */
export function remediationEventStatement(
  db: QueryableDatabase,
  event: RemediationEvent,
): D1PreparedStatement {
  return db
    .prepare(`
      INSERT INTO data_quality_remediation_events (
        listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
        resolver_method, resolver_confidence, resolver_version, processed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      event.listingProductId,
      text(event.shopKey, 100),
      text(event.sourceId, 200),
      event.field,
      text(event.previousValue),
      text(event.newValue),
      text(event.reason, 200),
      text(event.resolverMethod, 100),
      text(event.resolverConfidence, 20),
      Math.max(0, Math.trunc(Number(event.resolverVersion) || 0)),
      event.processedAt,
    );
}

export async function listRecentRemediationEvents(
  db: ReadableDatabase,
  limit = 50,
): Promise<RemediationEvent[]> {
  const result = await db
    .prepare(`
      SELECT id, listing_product_id, shop_key, source_id, field, previous_value, new_value, reason,
             resolver_method, resolver_confidence, resolver_version, processed_at
      FROM data_quality_remediation_events
      ORDER BY processed_at DESC, id DESC
      LIMIT ?
    `)
    .bind(Math.min(200, Math.max(1, Number(limit) || 50)))
    .all<RemediationEventRow>();
  return (result.results || []).map((row) => ({
    listingProductId: Number(row.listing_product_id),
    shopKey: row.shop_key,
    sourceId: row.source_id,
    field: row.field,
    previousValue: row.previous_value,
    newValue: row.new_value,
    reason: row.reason,
    resolverMethod: row.resolver_method,
    resolverConfidence: row.resolver_confidence,
    resolverVersion: Number(row.resolver_version || 0),
    processedAt: row.processed_at,
  }));
}
