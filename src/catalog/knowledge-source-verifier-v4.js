import { createKnowledgeSourceVerifierV3 } from './knowledge-source-verifier-v3.js';

export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 4;

// Keep manufacturer-specific discovery data outside the generic verifier. The generic v2 fallback
// can crawl these official indexes and same-origin product links, while v3 continues to provide its
// optimized adapters for the original manufacturers.
export const EXPANDED_OFFICIAL_SOURCES = Object.freeze([
  {
    manufacturerId: 'sony',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.sony.jp/',
    catalogUrls: [
      'https://www.sony.jp/audio/',
      'https://www.sony.jp/headphone/',
      'https://www.sony.jp/walkman/'
    ]
  },
  {
    manufacturerId: 'mcintosh',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.mcintoshlabs.com/',
    catalogUrls: [
      'https://www.mcintoshlabs.com/products/integrated-amplifiers',
      'https://www.mcintoshlabs.com/products/amplifiers',
      'https://www.mcintoshlabs.com/products/preamplifiers'
    ]
  },
  {
    manufacturerId: 'mark-levinson',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.marklevinson.com/',
    catalogUrls: [
      'https://www.marklevinson.com/products/integrated-amplifiers/',
      'https://www.marklevinson.com/products/preamplifiers/',
      'https://www.marklevinson.com/products/power-amplifiers/'
    ]
  },
  {
    manufacturerId: 'kef',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://jp.kef.com/',
    catalogUrls: [
      'https://jp.kef.com/collections/hifi-speakers',
      'https://jp.kef.com/collections/wireless-hifi-speakers',
      'https://jp.kef.com/collections/headphones'
    ]
  },
  {
    manufacturerId: 'jbl',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://jp.jbl.com/',
    catalogUrls: [
      'https://jp.jbl.com/home-audio/',
      'https://jp.jbl.com/home-electronics/',
      'https://jp.jbl.com/home-audio-discontinued/'
    ]
  },
  {
    manufacturerId: 'dali',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.dali-speakers.com/',
    catalogUrls: [
      'https://www.dali-speakers.com/en/products/',
      'https://www.dali-speakers.com/en/products/category/hi-fi-speakers/',
      'https://www.dali-speakers.com/en/products/category/passive-speakers/'
    ]
  },
  {
    manufacturerId: 'audio-technica',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.audio-technica.co.jp/',
    catalogUrls: [
      'https://www.audio-technica.co.jp/',
      'https://www.audio-technica.co.jp/category/headphone/',
      'https://www.audio-technica.co.jp/series/at-vmx/'
    ]
  },
  {
    manufacturerId: 'ortofon',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://ortofon.jp/',
    catalogUrls: [
      'https://ortofon.jp/product/',
      'https://ortofon.jp/product/1',
      'https://ortofon.jp/product/2'
    ]
  },
  {
    manufacturerId: 'stax',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://stax.co.jp/',
    catalogUrls: [
      'https://stax.co.jp/product/',
      'https://stax.co.jp/discontinued/'
    ]
  },
  {
    manufacturerId: 'fostex',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.fostex.jp/',
    catalogUrls: [
      'https://www.fostex.jp/',
      'https://www.fostex.jp/en/'
    ]
  },
  {
    manufacturerId: 'focal',
    sourceType: 'manufacturer_official',
    baseUrl: 'https://www.focal.com/',
    catalogUrls: [
      'https://www.focal.com/ja',
      'https://www.focal.com/ja/catalog/headphones/wireless-headphones',
      'https://www.focal.com/catalogs'
    ]
  }
]);

function parseRegistry(value) {
  if (!value) return [];
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (Array.isArray(parsed)) return parsed.filter(Boolean);
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([manufacturerId, config]) => ({
        manufacturerId,
        ...(config || {})
      }));
    }
  } catch {}
  return [];
}

export function expandedKnowledgeSourceEnv(env = {}) {
  const overrides = parseRegistry(env.KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON);
  return {
    ...env,
    // Expanded built-ins come first so an explicit deployment override later in the array retains
    // the existing replace/disable semantics of knowledgeSourceDefinitions().
    KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON: JSON.stringify([
      ...EXPANDED_OFFICIAL_SOURCES,
      ...overrides
    ])
  };
}

export function createKnowledgeSourceVerifierV4(env = {}, options = {}) {
  return createKnowledgeSourceVerifierV3(expandedKnowledgeSourceEnv(env), options);
}
