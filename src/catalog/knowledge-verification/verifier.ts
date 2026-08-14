/**
 * Composition root for Knowledge Catalog source verification.
 *
 * Verification answers one question — does the manufacturer's own site confirm this model and its
 * category? — by trying strategies in order and taking the first that verifies. The order is by
 * authority and cost: a manufacturer's category index states the category outright, a predictable
 * product URL costs one request, and site-wide discovery is the general but expensive last resort.
 *
 * The rollout version below is state metadata, not a code version: bumping it makes the Worker run
 * a one-shot review of the whole catalog. It advances when verification would now reach a different
 * conclusion, which is why it is unrelated to how many strategies exist.
 */

import { boundedNumber } from "./config.js";
import { clean } from "./html.js";
import { HTML_ACCEPT, fetchText } from "./http.js";
import { runVerificationPipeline } from "./pipeline.js";
import { resolveKnowledgeSourceDefinitions } from "./source-registry.js";
import { createDirectProductPageStrategy } from "./strategies/direct-product-page.js";
import { createGenericOfficialSiteStrategy } from "./strategies/generic-official-site.js";
import { applyOfficialFamilyCategory } from "./strategies/manufacturer/family-category.js";
import { createMarantzCdSacdIndexStrategy } from "./strategies/manufacturer/marantz-cd-sacd-index.js";
import { createOfficialIndexStrategy } from "./strategies/official-index.js";
import { verifyOfficialProductPage } from "./page-verification.js";
import type { VerificationStrategy } from "./pipeline.js";
import type { CrawlerEnv } from "../../crawler/types.js";
import type {
  FailedKnowledgeSource,
  FetchTextResult,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
  KnowledgeSourceVerifierOptions,
} from "./types.js";

/** Rollout state, not a code version. See the module comment. */
export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 5;

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

/** The generic discovery strategy reads a different mix of documents and is bounded separately. */
const DISCOVERY_DEFAULT_TIMEOUT_MS = 10_000;
const DISCOVERY_DEFAULT_MAX_RESPONSE_BYTES = 1_500_000;

/**
 * Generic discovery runs only after the targeted strategies have missed, so it is capped tightly
 * rather than from deployment variables: it is the slowest route and the least likely to verify.
 */
const DISCOVERY_BUDGET = Object.freeze({
  maxCatalogPages: 3,
  maxSitemaps: 2,
  maxDiscoveredUrls: 3_000,
  maxProductPages: 2,
});

const DEFAULT_USER_AGENT = "HiFiScoutBot/0.1";

function manufacturerIdOf(candidate: KnowledgeSourceCandidate | undefined): string {
  return String(candidate?.manufacturerId || "").toLowerCase();
}

export function createKnowledgeSourceVerifier(
  env: CrawlerEnv = {},
  { fetchImpl = globalThis.fetch, fallbackEnabled = true }: KnowledgeSourceVerifierOptions = {},
): KnowledgeSourceVerifier {
  const definitions = resolveKnowledgeSourceDefinitions(env);
  const userAgent = clean(env.CRAWLER_USER_AGENT) || DEFAULT_USER_AGENT;
  const timeoutMs = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
    1_000,
    20_000,
  );
  const maxBytes = boundedNumber(
    env.KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES,
    100_000,
    3_000_000,
  );

  // One index serves every alias of every candidate from the same manufacturer in a run.
  const pageCache = new Map<string, Promise<FetchTextResult>>();
  function fetchPage(url: string): Promise<FetchTextResult> {
    const cached = pageCache.get(url);
    if (cached) return cached;
    // These strategies only ever read HTML, so they keep the narrower Accept.
    const page = fetchText(fetchImpl, url, { timeoutMs, maxBytes, userAgent, accept: HTML_ACCEPT });
    pageCache.set(url, page);
    return page;
  }

  /** Carry their own official source, so they run before the supported-manufacturer check. */
  const overrideStrategies: readonly VerificationStrategy[] = [
    createMarantzCdSacdIndexStrategy({ fetchImpl }),
  ];

  const discoveryStrategies: VerificationStrategy[] = [
    createOfficialIndexStrategy({ fetchPage }),
    createDirectProductPageStrategy({ fetchPage }),
  ];
  if (fallbackEnabled) {
    discoveryStrategies.push(
      createGenericOfficialSiteStrategy({
        definitions,
        fetchImpl,
        timeoutMs: boundedNumber(
          env.KNOWLEDGE_CATALOG_SOURCE_TIMEOUT_MS,
          DISCOVERY_DEFAULT_TIMEOUT_MS,
          1_000,
          30_000,
        ),
        maxBytes: boundedNumber(
          env.KNOWLEDGE_CATALOG_SOURCE_MAX_RESPONSE_BYTES,
          DISCOVERY_DEFAULT_MAX_RESPONSE_BYTES,
          100_000,
          5_000_000,
        ),
        userAgent,
        budget: DISCOVERY_BUDGET,
      }),
    );
  }

  async function verifiedByOverride(
    candidate: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification | null> {
    for (const strategy of overrideStrategies) {
      const result = await strategy.verify(candidate);
      if (result?.status === "verified") return result;
    }
    return null;
  }

  async function verifyCandidate(
    candidate: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    const override = await verifiedByOverride(candidate);
    if (override) return override;

    if (!definitions.has(manufacturerIdOf(candidate))) {
      return {
        status: "unsupported",
        sourceType: "",
        sourceUrl: "",
        httpStatus: null,
        message: "no_official_source_adapter",
      };
    }

    const placeholder: FailedKnowledgeSource = {
      status: "not_found",
      sourceType: "manufacturer_official",
      sourceUrl: "",
      httpStatus: null,
      message: "official_product_page_not_discovered_v3",
    };
    const result = await runVerificationPipeline(discoveryStrategies, candidate, placeholder);
    return applyOfficialFamilyCategory(result, candidate);
  }

  /** Re-reads the page a product was originally verified from, to detect an official recategorization. */
  async function verifyStoredSource(
    product: KnowledgeSourceCandidate,
  ): Promise<KnowledgeSourceVerification> {
    const override = await verifiedByOverride(product);
    if (override) return override;

    if (!product?.sourceUrl) {
      return {
        status: "unsupported",
        sourceType: product?.sourceType || "",
        sourceUrl: "",
        httpStatus: null,
        message: "verified_product_has_no_source_url",
      };
    }

    const page = await fetchPage(product.sourceUrl);
    if (!page.ok) {
      return {
        status: page.status === 404 || page.status === 410 ? "not_found" : "error",
        sourceType: product.sourceType || "",
        sourceUrl: product.sourceUrl,
        httpStatus: page.status || null,
        message: page.error || `http_${page.status}`,
      };
    }

    const result = await verifyOfficialProductPage({
      candidate: {
        manufacturerId: product.manufacturerId,
        observedManufacturer: product.canonicalName,
        observedModel: product.canonicalModel,
        normalizedModel: product.normalizedModel,
      },
      html: page.text,
      sourceUrl: page.url,
      sourceType: product.sourceType || "manufacturer_official",
      httpStatus: page.status,
    });
    return applyOfficialFamilyCategory(result, product);
  }

  return { verifyCandidate, verifyStoredSource, definitions };
}
