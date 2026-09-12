import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { ReadableDatabase } from "./types.js";
import { firstMeasured } from "./read-accounting.js";
import { CATEGORY_VERSION_EXPRESSION } from "./resolution-version-sql.js";

const SCAN_LIMIT = 25;
// Discovery and the last-moment point check must use exactly the same eligibility and bindings.
const REPLAY_REQUIRED = `p.is_active = 1 AND (p.model_resolver_version < ?
  OR ${CATEGORY_VERSION_EXPRESSION} < ? OR p.remediation_projection_required = 1)`;
const VERSION_BINDINGS = [RESOLUTION_VERSIONS.model, RESOLUTION_VERSIONS.category];

/** Bound the inspected ID window before filtering stale rows, including an all-current tail. */
export async function scanAdminResolutionReplay(
  db: ReadableDatabase,
  afterId: number,
  maxId: number,
) {
  const { results } = await db
    .prepare(`
    SELECT p.id, ${REPLAY_REQUIRED} AS needs_replay
    FROM products p WHERE p.id > ? AND p.id <= ? ORDER BY p.id LIMIT ?
  `)
    .bind(...VERSION_BINDINGS, afterId, maxId, SCAN_LIMIT)
    .all<{ id: number; needs_replay: number }>();
  return {
    ids: results.filter((row) => row.needs_replay === 1).map((row) => row.id),
    scanned: results.length,
    afterId: results.at(-1)?.id ?? afterId,
    complete: results.length < SCAN_LIMIT || results.at(-1)?.id === maxId,
  };
}

/** Cron or a crawl may have finished a queued listing since the window was captured. */
export async function needsAdminResolutionReplay(
  db: ReadableDatabase,
  id: number,
): Promise<boolean> {
  return !!(await firstMeasured(
    db
      .prepare(`
    SELECT p.id FROM products p WHERE p.id = ? AND ${REPLAY_REQUIRED}
  `)
      .bind(id, ...VERSION_BINDINGS),
  ));
}
