/**
 * Which official sites verification is allowed to read, and where each one lists its products.
 *
 * The registry is layered so a deployment can override it without a code change:
 *
 * 1. {@link DEFAULT_OFFICIAL_SOURCES} — manufacturers with a hand-checked official site.
 * 2. {@link EXPANDED_OFFICIAL_SOURCES} — manufacturers reachable by generic discovery alone.
 * 3. `KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON` — deployment overrides, which replace or disable
 *    a built-in entry.
 * 4. {@link OFFICIAL_CATALOG_AUGMENTS} — extra index pages merged onto whichever entry survived,
 *    so discontinued products stay discoverable.
 *
 * Later layers win, which is what lets an operator disable a manufacturer whose site has changed
 * without waiting for a deploy.
 */

import { parseSourceRegistry } from "./config.js";
import { clean } from "./html.js";
import type { CrawlerEnv } from "../../crawler/types.js";
import type { KnowledgeSourceDefinition } from "./types.js";

/** Manufacturers whose official site has a verified entry point. */
const DEFAULT_OFFICIAL_SOURCES = Object.freeze([
  {
    manufacturerId: "luxman",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.luxman.co.jp/",
    catalogUrls: ["https://www.luxman.co.jp/"],
  },
  {
    manufacturerId: "accuphase",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.accuphase.com/",
    catalogUrls: ["https://www.accuphase.com/?lang=ja"],
  },
  {
    manufacturerId: "tad",
    sourceType: "manufacturer_official",
    baseUrl: "https://tad-labs.com/jp/",
    catalogUrls: ["https://tad-labs.com/jp/"],
  },
  {
    manufacturerId: "esoteric",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.esoteric.jp/jp/",
    catalogUrls: ["https://www.esoteric.jp/jp/"],
  },
  {
    manufacturerId: "yamaha",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.yamaha.com/",
    catalogUrls: ["https://jp.yamaha.com/products/audio_visual/hifi_components/"],
  },
  {
    manufacturerId: "denon",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.denon.com/ja-jp/",
    catalogUrls: ["https://www.denon.com/ja-jp/"],
  },
  {
    manufacturerId: "marantz",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.marantz.com/ja-jp/",
    catalogUrls: ["https://www.marantz.com/ja-jp/"],
  },
  {
    manufacturerId: "technics",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.technics.com/",
    catalogUrls: ["https://jp.technics.com/"],
  },
]);

/**
 * Manufacturers added once generic discovery could reach them unaided.
 *
 * These have no bespoke strategy: the generic official-site strategy crawls the listed indexes and
 * follows same-origin product links.
 */
export const EXPANDED_OFFICIAL_SOURCES = Object.freeze([
  {
    manufacturerId: "sony",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.sony.jp/",
    catalogUrls: [
      "https://www.sony.jp/audio/",
      "https://www.sony.jp/headphone/",
      "https://www.sony.jp/walkman/",
    ],
  },
  {
    manufacturerId: "mcintosh",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.mcintoshlabs.com/",
    catalogUrls: [
      "https://www.mcintoshlabs.com/products/integrated-amplifiers",
      "https://www.mcintoshlabs.com/products/amplifiers",
      "https://www.mcintoshlabs.com/products/preamplifiers",
    ],
  },
  {
    manufacturerId: "mark-levinson",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.marklevinson.com/",
    catalogUrls: [
      "https://www.marklevinson.com/products/integrated-amplifiers/",
      "https://www.marklevinson.com/products/preamplifiers/",
      "https://www.marklevinson.com/products/power-amplifiers/",
    ],
  },
  {
    manufacturerId: "kef",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.kef.com/",
    catalogUrls: [
      "https://jp.kef.com/collections/hifi-speakers",
      "https://jp.kef.com/collections/wireless-hifi-speakers",
      "https://jp.kef.com/collections/headphones",
    ],
  },
  {
    manufacturerId: "jbl",
    sourceType: "manufacturer_official",
    baseUrl: "https://jp.jbl.com/",
    catalogUrls: [
      "https://jp.jbl.com/home-audio/",
      "https://jp.jbl.com/home-electronics/",
      "https://jp.jbl.com/home-audio-discontinued/",
    ],
  },
  {
    manufacturerId: "dali",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.dali-speakers.com/",
    catalogUrls: [
      "https://www.dali-speakers.com/en/products/",
      "https://www.dali-speakers.com/en/products/category/hi-fi-speakers/",
      "https://www.dali-speakers.com/en/products/category/passive-speakers/",
    ],
  },
  {
    manufacturerId: "audio-technica",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.audio-technica.co.jp/",
    catalogUrls: [
      "https://www.audio-technica.co.jp/",
      "https://www.audio-technica.co.jp/category/headphone/",
      "https://www.audio-technica.co.jp/series/at-vmx/",
    ],
  },
  {
    manufacturerId: "ortofon",
    sourceType: "manufacturer_official",
    baseUrl: "https://ortofon.jp/",
    catalogUrls: [
      "https://ortofon.jp/product/",
      "https://ortofon.jp/product/1",
      "https://ortofon.jp/product/2",
    ],
  },
  {
    manufacturerId: "stax",
    sourceType: "manufacturer_official",
    baseUrl: "https://stax.co.jp/",
    catalogUrls: ["https://stax.co.jp/product/", "https://stax.co.jp/discontinued/"],
  },
  {
    manufacturerId: "fostex",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.fostex.jp/",
    catalogUrls: ["https://www.fostex.jp/", "https://www.fostex.jp/en/"],
  },
  {
    manufacturerId: "focal",
    sourceType: "manufacturer_official",
    baseUrl: "https://www.focal.com/",
    catalogUrls: [
      "https://www.focal.com/ja",
      "https://www.focal.com/ja/catalog/headphones/wireless-headphones",
      "https://www.focal.com/catalogs",
    ],
  },
]);

/**
 * Index pages merged onto a manufacturer's own entry.
 *
 * Current-product indexes drop discontinued models, which is most of what a used-audio catalog
 * needs, so the archive/history pages are added rather than replacing the configured catalog.
 */
const OFFICIAL_CATALOG_AUGMENTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  luxman: ["https://www.luxman.co.jp/product/"],
  accuphase: ["https://www.accuphase.com/product.html", "https://www.accuphase.com/history"],
  tad: ["https://tad-labs.com/jp/support/catalogue/"],
  esoteric: ["https://www.esoteric.jp/jp/support/discon"],
  denon: [
    "https://www.denon.com/ja-jp/category/archive-amplifiers/",
    "https://www.denon.com/ja-jp/category/archive-cd-players/",
    "https://www.denon.com/ja-jp/category/turntables/",
    "https://www.denon.com/ja-jp/category/archive-turntable-cartridges/",
  ],
  marantz: [
    "https://www.marantz.com/ja-jp/category/archive-amplifiers/",
    "https://www.marantz.com/ja-jp/category/archive-cd-players/",
    "https://www.marantz.com/ja-jp/category/archive-network-audio-players/",
  ],
  technics: ["https://jp.technics.com/products/?sort=tt"],
});

/** Rejects anything without a usable http(s) base URL rather than fetching a malformed override. */
function normalizedSource(source: Record<string, unknown> = {}): KnowledgeSourceDefinition | null {
  const manufacturerId = clean(source.manufacturerId).toLowerCase();
  const baseUrl = clean(source.baseUrl);
  if (!manufacturerId || !baseUrl || source.enabled === false) return null;

  let base;
  try {
    base = new URL(baseUrl);
    if (!["http:", "https:"].includes(base.protocol)) return null;
  } catch {
    return null;
  }

  const catalogUrls: string[] = Array.isArray(source.catalogUrls)
    ? source.catalogUrls.filter(Boolean).map(String)
    : [base.toString()];
  const sitemapUrls: string[] = Array.isArray(source.sitemapUrls)
    ? source.sitemapUrls.filter(Boolean).map(String)
    : [];

  return {
    manufacturerId,
    adapter: "official_site",
    sourceType: clean(source.sourceType) || "manufacturer_official",
    baseUrl: base.toString(),
    catalogUrls,
    sitemapUrls,
    searchUrlTemplate: clean(source.searchUrlTemplate),
  };
}

/**
 * Built-in sources merged with the deployment registry.
 *
 * An override replaces the built-in entry for its manufacturer by default; `replace: false` appends
 * an additional source, and `enabled: false` removes the manufacturer entirely.
 */
export function knowledgeSourceDefinitions(
  env: CrawlerEnv = {},
): Map<string, KnowledgeSourceDefinition[]> {
  const byManufacturer = new Map<string, KnowledgeSourceDefinition[]>();
  for (const source of DEFAULT_OFFICIAL_SOURCES) {
    const normalized = normalizedSource({ ...source });
    if (normalized) byManufacturer.set(normalized.manufacturerId, [normalized]);
  }

  for (const raw of parseSourceRegistry(env.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON)) {
    const manufacturerId = clean(raw.manufacturerId).toLowerCase();
    if (!manufacturerId) continue;
    if (raw.enabled === false) {
      byManufacturer.delete(manufacturerId);
      continue;
    }
    const normalized = normalizedSource(raw);
    if (!normalized) continue;
    if (raw?.replace === false && byManufacturer.has(manufacturerId)) {
      byManufacturer.get(manufacturerId)?.push(normalized);
    } else {
      byManufacturer.set(manufacturerId, [normalized]);
    }
  }
  return byManufacturer;
}

/**
 * Prepends the expanded built-ins to the deployment registry.
 *
 * They go first so an explicit deployment override later in the array keeps the replace/disable
 * semantics of {@link knowledgeSourceDefinitions}.
 */
export function expandedKnowledgeSourceEnv(env: CrawlerEnv = {}): CrawlerEnv {
  const overrides = parseSourceRegistry(env.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON);
  return {
    ...env,
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      ...EXPANDED_OFFICIAL_SOURCES,
      ...overrides,
    ]),
  };
}

/** The definitions verification actually runs against: expanded built-ins plus archive indexes. */
export function resolveKnowledgeSourceDefinitions(
  env: CrawlerEnv = {},
): Map<string, KnowledgeSourceDefinition[]> {
  const definitions = knowledgeSourceDefinitions(expandedKnowledgeSourceEnv(env));
  const result = new Map<string, KnowledgeSourceDefinition[]>();
  for (const [manufacturerId, sources] of definitions) {
    result.set(
      manufacturerId,
      sources.map((source) => ({
        ...source,
        catalogUrls: [
          ...new Set([
            ...(source.catalogUrls || []),
            ...(OFFICIAL_CATALOG_AUGMENTS[manufacturerId] || []),
          ]),
        ],
      })),
    );
  }
  return result;
}
