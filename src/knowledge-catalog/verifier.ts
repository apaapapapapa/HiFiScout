/**
 * How the queue builds a verifier, and how it decides which domain a job belongs to.
 *
 * Verification reads third-party sites, so every job's fetch goes through the robots-respecting
 * transport with a minimum delay. A verifier is built per job rather than shared: its page cache is
 * scoped to one candidate's work, and sharing it across a batch would let one target's fetches
 * satisfy another's.
 */

import { createKnowledgeSourceVerifier } from "../catalog/knowledge-verification/verifier.js";
import { createRobotsRespectingFetch } from "../crawler/robots-respecting-fetch.js";
import { errorMessage } from "../types.js";
import type {
  FailedKnowledgeSource,
  KnowledgeSourceVerification,
} from "../catalog/knowledge-verification/types.js";
import { sourceRequestDelayMs } from "./policy.js";
import type { KnowledgeSourceVerifier } from "../catalog/knowledge-verification/types.js";
import type { KnowledgeCatalogQueueEnv } from "./types.js";

const DEFAULT_USER_AGENT = "HiFiScoutBot/0.1";

export type VerifierFactory = (
  env: KnowledgeCatalogQueueEnv,
  fetchImpl?: typeof fetch,
) => KnowledgeSourceVerifier;

function sourceFetcher(
  env: KnowledgeCatalogQueueEnv,
  fetchImpl: typeof fetch = globalThis.fetch,
): typeof fetch {
  return createRobotsRespectingFetch(fetchImpl, {
    userAgent: env.CRAWLER_USER_AGENT || DEFAULT_USER_AGENT,
    minimumDelayMs: sourceRequestDelayMs(env),
  });
}

export const createVerifier: VerifierFactory = (env, fetchImpl = globalThis.fetch) => {
  // This verifier belongs to one target. A failed discovery/index/robots read must not disappear
  // when a strategy falls through to its generic "not found" placeholder.
  let failure: FailedKnowledgeSource | undefined;
  const fetchSource = sourceFetcher(env, fetchImpl);
  const observedFetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    try {
      const response = await fetchSource(input, init);
      if (!response.ok && response.status !== 404 && response.status !== 410) {
        failure ??= {
          status: "error",
          sourceUrl: response.url || url,
          sourceType: "manufacturer_official",
          httpStatus: response.status,
          message: `http_${response.status}`,
        };
      }
      return response;
    } catch (error) {
      failure ??= {
        status: "error",
        sourceUrl: url,
        sourceType: "manufacturer_official",
        httpStatus: null,
        message: errorMessage(error),
      };
      throw error;
    }
  };
  const verifier = createKnowledgeSourceVerifier(env, {
    fetchImpl: observedFetch,
    // Queue jobs are per-target and already rate-limited per domain, so the expensive generic
    // discovery is affordable here.
    fallbackEnabled: true,
  });
  const preserveFailure = (result: KnowledgeSourceVerification): KnowledgeSourceVerification =>
    result.status === "not_found" && failure ? failure : result;
  return {
    definitions: verifier.definitions,
    verifyCandidate: async (target) => preserveFailure(await verifier.verifyCandidate(target)),
    verifyStoredSource: async (target) =>
      preserveFailure(await verifier.verifyStoredSource(target)),
  };
};

/**
 * The host a job will contact, used as the key for its domain lease.
 *
 * A stored source URL is authoritative. Otherwise the manufacturer's registered base URL stands in,
 * and if even that is unavailable a per-manufacturer pseudo-host keeps the job serialized against
 * its own kind rather than sharing a lease with every other unknown source.
 */
export function sourceHostname(
  verifier: KnowledgeSourceVerifier,
  manufacturerId: string,
  sourceUrl = "",
): string {
  if (sourceUrl) {
    try {
      return new URL(sourceUrl).hostname.toLowerCase();
    } catch {}
  }
  const definitions = verifier?.definitions?.get(String(manufacturerId || "").toLowerCase()) || [];
  for (const definition of definitions) {
    try {
      const hostname = new URL(definition.baseUrl).hostname.toLowerCase();
      if (hostname) return hostname;
    } catch {}
  }
  return `manufacturer-${String(manufacturerId || "unknown").toLowerCase()}`;
}
