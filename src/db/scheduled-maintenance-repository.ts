import { firstMeasured } from "./read-accounting.js";
import type { QueryableDatabase } from "./types.js";

// Shorter than the five-minute tick, longer than the runner's 20-second wall budget.
const LEASE_MS = 4 * 60 * 1000;

export async function enqueueMaintenance(
  db: QueryableDatabase,
  names: readonly string[],
  now: Date,
) {
  if (!names.length) return;
  await db
    .prepare(`
    INSERT INTO scheduled_maintenance_pending(task_name, due_at)
    VALUES ${names.map(() => "(?, ?)").join(",")}
    ON CONFLICT(task_name) DO NOTHING
  `)
    .bind(...names.flatMap((name) => [name, now.toISOString()]))
    .run();
}

/** Oldest unattempted work first; a failed or budget-limited task moves behind untouched work. */
export async function pendingMaintenance(db: QueryableDatabase, now: Date): Promise<string[]> {
  const rows = await db
    .prepare(`
    SELECT task_name FROM scheduled_maintenance_pending
    WHERE claimed_at IS NULL OR claimed_at < ?
    ORDER BY COALESCE(claimed_at, due_at), claimed_at IS NOT NULL, due_at, task_name
  `)
    .bind(new Date(now.getTime() - LEASE_MS).toISOString())
    .all<{ task_name: string }>();
  return (rows.results || []).map((row) => row.task_name);
}

export async function claimMaintenance(
  db: QueryableDatabase,
  name: string,
  now: Date,
): Promise<string | null> {
  const token = crypto.randomUUID();
  const row = await firstMeasured<{ claim_token: string }>(
    db
      .prepare(`
    UPDATE scheduled_maintenance_pending SET claimed_at = ?, claim_token = ?
    WHERE task_name = ? AND (claimed_at IS NULL OR claimed_at < ?)
    RETURNING claim_token
  `)
      .bind(now.toISOString(), token, name, new Date(now.getTime() - LEASE_MS).toISOString()),
  );
  return row?.claim_token || null;
}

export async function completeMaintenance(db: QueryableDatabase, name: string, token: string) {
  await db
    .prepare("DELETE FROM scheduled_maintenance_pending WHERE task_name = ? AND claim_token = ?")
    .bind(name, token)
    .run();
}
