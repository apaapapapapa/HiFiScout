import { catalogModelLookupVariants } from './knowledge-catalog.js';
import { containsFlexibleCatalogModelIdentity } from './knowledge-source-verifier-v2.js';
import { createKnowledgeSourceVerifierV3 } from './knowledge-source-verifier-v3.js';

// The module name is kept stable for existing imports; the rollout version advances whenever
// verification behavior changes and a one-shot production review must run again.
export const KNOWLEDGE_CATALOG_VERIFIER_VERSION = 5;

const MARANTZ_CD_SACD_INDEX = 'https://www.marantz.com/ja-jp/category/cd-sacd-players/';

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
        ...config
      }));
    }
  } catch {}
  return [];
}

function candidateModel(candidate = {}) {
  return String(candidate.observedModel || candidate.model || candidate.canonicalModel || candidate.normalizedModel || '').trim();
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) return '';
  const bytes = new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function verifyMarantzCdSacdIndex(candidate, fetchImpl) {
  const manufacturerId = String(candidate?.manufacturerId || '').trim().toLowerCase();
  if (manufacturerId !== 'marantz' || typeof fetchImpl !== 'function') return null;

  const originalModel = candidateModel(candidate);
  if (!originalModel) return null;
  const aliases = catalogModelLookupVariants({ manufacturerId, model: originalModel })
    .filter(alias => /^(?:SACD|CD)(?:\s|\d)/i.test(alias));
  if (!aliases.length) return null;

  try {
    const response = await fetchImpl(MARANTZ_CD_SACD_INDEX, {
      redirect: 'follow',
      headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
    });
    if (!response?.ok) return null;
    const html = (await response.text()).slice(0, 1_500_000);
    const matchedAlias = aliases.find(alias => containsFlexibleCatalogModelIdentity(html, alias));
    if (!matchedAlias) return null;

    // This is a manufacturer-owned, category-specific index. Once the model identity is confirmed
    // on the page, the page category itself is authoritative and avoids accidental DAC inference
    // from SACD 10's USB-DAC feature description.
    return {
      status: 'verified',
      sourceUrl: response.url || MARANTZ_CD_SACD_INDEX,
      sourceType: 'manufacturer_official',
      httpStatus: response.status || 200,
      canonicalModel: originalModel,
      canonicalName: `Marantz ${matchedAlias}`,
      categoryIds: ['cd_sacd_player'],
      primaryCategoryId: 'cd_sacd_player',
      contentHash: await sha256Hex(html),
      message: 'verified_from_marantz_cd_sacd_index_v5'
    };
  } catch {
    return null;
  }
}

function officialFamilyCategory(candidate = {}) {
  const manufacturerId = String(candidate.manufacturerId || '').trim().toLowerCase();
  const model = String(candidate.canonicalModel || candidate.observedModel || candidate.model || candidate.normalizedModel || '')
    .normalize('NFKC')
    .trim()
    .toUpperCase();
  // STAX uses SRM for electrostatic headphone driver units. Some models advertise their built-in
  // DAC more prominently than the amplifier role, so generic text classification can otherwise
  // choose DAC even though the product itself is a headphone amplifier/driver unit.
  if (manufacturerId === 'stax' && /^SRM(?:[-\s]|\d)/.test(model)) return 'headphone_amp';
  // McIntosh MHA is the dedicated headphone-amplifier family (for example MHA200). Product titles
  // can contain "Headphone Power Amplifier", where a generic power-amplifier rule is too broad.
  if (manufacturerId === 'mcintosh' && /^MHA(?:[-\s]|\d)/.test(model)) return 'headphone_amp';
  return '';
}

function applyOfficialFamilyCategory(result, candidate) {
  if (result?.status !== 'verified') return result;
  const categoryId = officialFamilyCategory(candidate);
  if (!categoryId) return result;
  return {
    ...result,
    categoryIds: [categoryId],
    primaryCategoryId: categoryId,
    message: `${result.message || 'verified'}:official_family_v5`
  };
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
  const base = createKnowledgeSourceVerifierV3(expandedKnowledgeSourceEnv(env), options);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  return {
    ...base,
    async verifyCandidate(candidate) {
      const marantz = await verifyMarantzCdSacdIndex(candidate, fetchImpl);
      if (marantz) return marantz;
      return applyOfficialFamilyCategory(await base.verifyCandidate(candidate), candidate);
    },
    async verifyStoredSource(product) {
      const marantz = await verifyMarantzCdSacdIndex(product, fetchImpl);
      if (marantz) return marantz;
      return applyOfficialFamilyCategory(await base.verifyStoredSource(product), product);
    }
  };
}
