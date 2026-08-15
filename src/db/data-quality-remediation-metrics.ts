import {
  dataQualityRemediationQueueMetrics,
  type QueueMetrics,
} from "./data-quality-remediation-queue-repository.js";
import type { QueryableDatabase } from "./types.js";

export interface DataQualityRemediationOperationalMetrics extends QueueMetrics {
  completed: number;
  failureRate: number | null;
}

/**
 * Operational queue health derived from retained terminal work.
 *
 * Backlog is instantaneous. Failure rate is intentionally based only on terminal attempts so
 * pending/processing work cannot make the queue appear healthier. Resolved history is retention
 * bounded; failed rows remain available for diagnosis.
 */
export function remediationOperationalMetrics(
  queue: QueueMetrics,
): DataQualityRemediationOperationalMetrics {
  const completed = queue.resolved + queue.failed;
  return {
    ...queue,
    completed,
    failureRate: completed ? queue.failed / completed : null,
  };
}

export async function dataQualityRemediationOperationalMetrics(
  db: QueryableDatabase,
): Promise<DataQualityRemediationOperationalMetrics> {
  return remediationOperationalMetrics(await dataQualityRemediationQueueMetrics(db));
}
