import type { QueryableDatabase } from "../../src/db/types.js";

export const EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER = "resolver_replay_drain_recovery_v1";

/**
 * Grant exactly one additional attempt to an automatic remediation job whose final lease expired
 * without the worker getting a chance to resolve or fail it.
 *
 * A process can disappear after claiming its last permitted attempt. In that case the queue row is
 * left in `processing` with `attempt_count >= max_attempts`; normal claim logic deliberately refuses
 * to reclaim it, so the deterministic automatic work key also prevents the stale listing from being
 * seeded again. The administrative drain is the recovery boundary for that infrastructure failure.
 *
 * We increase `max_attempts` by one instead of resetting attempt history. The source marker makes the
 * recovery one-shot: if the recovered attempt itself later disappears, the job is not granted an
 * unbounded retry budget. A normal execution error on the recovered attempt therefore becomes a
 * terminal failure through the existing retry/fail path and remains visible to the drain.
 */
export async function recoverExpiredExhaustedAutomaticRemediationJobs(
  db: QueryableDatabase,
  now = new Date().toISOString(),
): Promise<number> {
  const result = await db
    .prepare(`
      UPDATE data_quality_remediation_queue
      SET status = 'pending',
          max_attempts = max_attempts + 1,
          available_at = ?,
          claimed_at = NULL,
          lease_expires_at = NULL,
          resolved_at = NULL,
          source = CASE
            WHEN source = '' THEN ?
            ELSE source || ':' || ?
          END,
          last_error = CASE
            WHEN last_error = '' THEN 'recovered expired exhausted automatic lease'
            ELSE last_error || '; recovered expired exhausted automatic lease'
          END,
          updated_at = ?
      WHERE status = 'processing'
        AND attempt_count >= max_attempts
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        AND work_key LIKE 'auto:%'
        AND instr(source, ?) = 0
    `)
    .bind(
      now,
      EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER,
      EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER,
      now,
      now,
      EXHAUSTED_LEASE_RECOVERY_SOURCE_MARKER,
    )
    .run();

  return Number(result?.meta?.changes || 0);
}
