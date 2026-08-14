/**
 * Ordered evaluation of verification strategies.
 *
 * Strategies are tried cheapest-and-most-authoritative first and the first `verified` result wins,
 * so a manufacturer's own category index is preferred over a site-wide crawl that might land on a
 * marketing page.
 *
 * When nothing verifies, the reported failure matters: it is written to the catalog and drives
 * whether a candidate is retried. `ambiguous` always outranks `not_found` because it means a page
 * about this model was found and only its category was unusable — a human-reviewable outcome,
 * unlike "no page anywhere mentions this model".
 */

import type {
  FailedKnowledgeSource,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
} from "../types.js";

export interface VerificationStrategy {
  /** Identifies the strategy in tests and in composition order; not persisted. */
  readonly name: string;
  /**
   * Whether this strategy's plain failures may stand in for the pipeline's placeholder.
   *
   * Strategies that only look in a few known places have nothing useful to say when they find
   * nothing, so they leave the placeholder alone. A strategy that searched the whole site does:
   * its `error` or `http_404` is the most informative account of why the candidate failed.
   */
  readonly reportsUnresolvedFailure?: boolean;
  /** Returns `null` when the strategy does not apply to this candidate at all. */
  verify(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification | null>;
}

export async function runVerificationPipeline(
  strategies: readonly VerificationStrategy[],
  candidate: KnowledgeSourceCandidate,
  placeholder: FailedKnowledgeSource,
): Promise<KnowledgeSourceVerification> {
  let bestFailure: KnowledgeSourceVerification = placeholder;
  for (const strategy of strategies) {
    const result = await strategy.verify(candidate);
    if (!result) continue;
    if (result.status === "verified") return result;
    if (
      result.status === "ambiguous" ||
      (strategy.reportsUnresolvedFailure && bestFailure.status === "not_found")
    ) {
      bestFailure = result;
    }
  }
  return bestFailure;
}

/**
 * Collapses the many attempts one strategy makes into its single best answer.
 *
 * Mirrors {@link runVerificationPipeline} within a strategy: the first verified page ends the
 * search, otherwise the last ambiguous page is reported and plain misses are discarded.
 */
export class StrategyAttempts {
  #ambiguous: KnowledgeSourceVerification | null = null;

  /** Returns the result when it ends the search, so callers can `return` it directly. */
  record(result: KnowledgeSourceVerification | null): KnowledgeSourceVerification | null {
    if (!result) return null;
    if (result.status === "verified") return result;
    if (result.status === "ambiguous") this.#ambiguous = result;
    return null;
  }

  best(): KnowledgeSourceVerification | null {
    return this.#ambiguous;
  }
}
