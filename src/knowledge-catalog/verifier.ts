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
import type { KnowledgeSourceVerifier } from "../catalog/knowledge-verification/types.js";
import type { KnowledgeCatalogQueueEnv } from "./types.js";

const DEFAULT_USER_AGENT = "HiFiScoutBot/0.1";
const DEFAULT_REQUEST_DELAY_MS = 500;

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
    minimumDelayMs:
      Number(env.KNOWLEDGE_CATALOG_SOURCE_REQUEST_DELAY_MS) || DEFAULT_REQUEST_DELAY_MS,
  });
}

export const createVerifier: VerifierFactory = (env, fetchImpl = globalThis.fetch) =>
  createKnowledgeSourceVerifier(env, {
    fetchImpl: sourceFetcher(env, fetchImpl),
    // Queue jobs are per-target and already rate-limited per domain, so the expensive generic
    // discovery is affordable here.
    fallbackEnabled: true,
  });

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
