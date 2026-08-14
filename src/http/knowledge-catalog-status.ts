/**
 * `/api/knowledge-catalog/status`: operational counters, verification queue depth, and how far the
 * current verifier rollout has progressed.
 *
 * `expectedVersion` is what this deployment ships; `version` is what the last completed rollout
 * recorded. They differ while a rollout is in flight, which is the point of exposing both.
 */

import { KNOWLEDGE_CATALOG_VERIFIER_VERSION } from "../catalog/knowledge-source-verifier-v4.js";
import { knowledgeCatalogOperationalStatus } from "../db/knowledge-catalog-review-repository.js";
import { knowledgeCatalogVerificationQueueStatus } from "../db/knowledge-catalog-verification-queue-repository.js";
import { knowledgeCatalogVerifierState } from "../db/knowledge-catalog-verifier-state-repository.js";

export async function knowledgeCatalogStatus(env: Env) {
  const [status, state, queue] = await Promise.all([
    knowledgeCatalogOperationalStatus(env.DB),
    knowledgeCatalogVerifierState(env.DB),
    knowledgeCatalogVerificationQueueStatus(env.DB),
  ]);
  return {
    ...status,
    queue,
    verifier: {
      expectedVersion: KNOWLEDGE_CATALOG_VERIFIER_VERSION,
      version: state?.version || 0,
      status: state?.status || "pending",
      startedAt: state?.startedAt || null,
      finishedAt: state?.finishedAt || null,
      message: state?.message || "",
    },
  };
}
