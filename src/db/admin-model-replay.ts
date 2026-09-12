import { MODEL_RESOLVER_VERSION } from "../catalog/model-resolver.js";
import type { ReadableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";

const SCAN_LIMIT = 25;

/** Bound the inspected ID window before filtering stale rows, including an all-current tail. */
export async function scanAdminModelReplay(db: ReadableDatabase, afterId: number, maxId: number) {
  const { results } = await db
    .prepare(`
    SELECT id, is_active, model_resolver_version, remediation_projection_required
    FROM products WHERE id > ? AND id <= ? ORDER BY id LIMIT ?
  `)
    .bind(afterId, maxId, SCAN_LIMIT)
    .all<{
      id: number;
      is_active: number;
      model_resolver_version: number;
      remediation_projection_required: number;
    }>();
  return {
    ids: results
      .filter(
        (row) =>
          row.is_active === 1 &&
          (row.model_resolver_version < MODEL_RESOLVER_VERSION ||
            row.remediation_projection_required === 1),
      )
      .map((row) => row.id),
    scanned: results.length,
    afterId: results.at(-1)?.id ?? afterId,
    complete: results.length < SCAN_LIMIT || results.at(-1)?.id === maxId,
  };
}

/** Cron or a crawl may have finished a queued listing since the window was captured. */
export async function needsAdminModelReplay(db: ReadableDatabase, id: number): Promise<boolean> {
  return !!(await firstMeasured(
    db
      .prepare(`
    SELECT id FROM products WHERE id = ? AND is_active = 1
      AND (model_resolver_version < ? OR remediation_projection_required = 1)
  `)
      .bind(id, MODEL_RESOLVER_VERSION),
  ));
}
