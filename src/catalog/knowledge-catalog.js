function clean(value = '') {
  return String(value).normalize('NFKC').trim();
}

export function normalizeCatalogModel(value = '') {
  return clean(value)
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/\s*([./_-])\s*/g, '$1')
    .trim();
}

function addLookupVariant(target, value) {
  const normalized = normalizeCatalogModel(value);
  if (normalized) target.add(normalized);
  return normalized;
}

function stripListingAnnotations(value = '') {
  return clean(value)
    .replace(/\s*《[^》]{1,40}》\s*/g, ' ')
    .replace(/\s*【[^】]*(?:販売済|売約|SOLD(?:\s*OUT)?|売切|品切)[^】]*】\s*$/gi, '')
    .replace(/\s*\[[A-Z0-9][A-Z0-9._/-]{3,}\]\s*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripPresentationVariant(value = '') {
  return clean(value)
    .replace(/\s*\/\s*(?:ブラック|ホワイト|シルバー|ゴールド|レッド|ブルー|ブラウン|黒|白|銀|black|white|silver|gold)(?:\s*[（(]?(?:ペア|pair)[）)]?)?\s*$/i, '')
    .replace(/\s*[（(](?:B|S|BK|WH|W|K|ブラック|ホワイト|シルバー|黒|白|銀)[）)]\s*$/i, '')
    .trim();
}

function stripManufacturerMarketSuffix(value, manufacturerId) {
  const normalized = normalizeCatalogModel(value);
  if (manufacturerId === 'denon') {
    if (/^(?:AH|AVR|AVC|DCD|DHT|DNP|DP|PMA|RCD)-/i.test(normalized)) {
      const withoutColor = normalized.replace(/-(?:BK|SP|K|W|WH)$/i, '');
      if (withoutColor !== normalized) return withoutColor;
    }
    if (/^AH-[A-Z0-9-]+EM$/i.test(normalized)) return normalized.replace(/EM$/i, '');
  }
  return normalized;
}

/**
 * Produces conservative lookup aliases for official-source verification without changing the
 * persisted catalog identity. Listing-only annotations such as colors, retailer SKUs and sold
 * markers may be removed, while meaningful revisions (SE/X/XD/MKII/Pro/Limited) are preserved.
 */
export function catalogModelLookupVariants({ manufacturerId = '', model = '' } = {}) {
  const manufacturer = clean(manufacturerId).toLowerCase();
  const variants = new Set();
  const original = clean(model);
  if (!original) return [];

  addLookupVariant(variants, original);
  let simplified = stripListingAnnotations(original);
  addLookupVariant(variants, simplified);

  simplified = stripPresentationVariant(simplified);
  addLookupVariant(variants, simplified);

  const marketStripped = stripManufacturerMarketSuffix(simplified, manufacturer);
  addLookupVariant(variants, marketStripped);

  // A seller may describe a base product bundled with an optional board, e.g. C-2800+AD-290V.
  // The complete listing identity remains intact, but the base product is a valid verification key.
  const plusIndex = marketStripped.indexOf('+');
  if (plusIndex > 0) addLookupVariant(variants, marketStripped.slice(0, plusIndex));

  return [...variants].sort((left, right) => left.length - right.length || left.localeCompare(right));
}

export function knowledgeCatalogKey(manufacturerId = '', model = '') {
  const manufacturer = clean(manufacturerId).toLowerCase();
  const normalizedModel = normalizeCatalogModel(model);
  return manufacturer && normalizedModel ? `${manufacturer}:${normalizedModel}` : '';
}

function parseCategoryIds(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  try {
    const parsed = JSON.parse(value || '[]');
    return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
  } catch {
    return [];
  }
}

function earlier(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return left < right ? left : right;
}

function later(left, right) {
  if (!left) return right || '';
  if (!right) return left;
  return left > right ? left : right;
}

export function candidatePriority({ unclassifiedCount = 0, shopCount = 0, listingCount = 0 } = {}) {
  return Number(unclassifiedCount) * 100 + Number(shopCount) * 10 + Math.min(Number(listingCount), 9);
}

export function accumulateKnowledgeCatalogCandidateRows(grouped, rows = []) {
  const target = grouped || new Map();
  for (const row of rows) {
    const key = knowledgeCatalogKey(row?.manufacturer_id, row?.model);
    if (!key) continue;
    const normalizedModel = normalizeCatalogModel(row.model);
    let candidate = target.get(key);
    if (!candidate) {
      candidate = {
        manufacturerId: clean(row.manufacturer_id).toLowerCase(),
        normalizedModel,
        observedManufacturer: clean(row.manufacturer),
        observedModel: clean(row.model),
        sampleTitle: clean(row.title),
        listingCount: 0,
        shops: new Set(),
        categories: new Set(),
        unclassifiedCount: 0,
        firstSeenAt: '',
        lastSeenAt: ''
      };
      target.set(key, candidate);
    }

    candidate.listingCount += 1;
    if (row.shop_key) candidate.shops.add(String(row.shop_key));
    for (const categoryId of parseCategoryIds(row.category_ids)) candidate.categories.add(categoryId);
    if (row.classification_status !== 'classified') {
      candidate.unclassifiedCount += 1;
      if (row.title) candidate.sampleTitle = clean(row.title);
    }
    candidate.firstSeenAt = earlier(candidate.firstSeenAt, row.first_seen_at);
    candidate.lastSeenAt = later(candidate.lastSeenAt, row.last_seen_at);
  }
  return target;
}

export function finalizeKnowledgeCatalogCandidateAggregates(grouped = new Map()) {
  return [...grouped.values()].map(candidate => {
    const shopCount = candidate.shops.size;
    const result = {
      manufacturerId: candidate.manufacturerId,
      normalizedModel: candidate.normalizedModel,
      observedManufacturer: candidate.observedManufacturer,
      observedModel: candidate.observedModel,
      sampleTitle: candidate.sampleTitle,
      categoryIds: [...candidate.categories].sort(),
      listingCount: candidate.listingCount,
      shopCount,
      unclassifiedCount: candidate.unclassifiedCount,
      firstSeenAt: candidate.firstSeenAt,
      lastSeenAt: candidate.lastSeenAt
    };
    return { ...result, priorityScore: candidatePriority(result) };
  }).sort((left, right) =>
    right.priorityScore - left.priorityScore ||
    right.listingCount - left.listingCount ||
    left.manufacturerId.localeCompare(right.manufacturerId) ||
    left.normalizedModel.localeCompare(right.normalizedModel)
  );
}

export function buildKnowledgeCatalogCandidateAggregates(rows = []) {
  return finalizeKnowledgeCatalogCandidateAggregates(accumulateKnowledgeCatalogCandidateRows(new Map(), rows));
}

export function knowledgeCatalogEvidence(match) {
  const categoryIds = Array.isArray(match?.categoryIds) ? match.categoryIds.filter(Boolean) : [];
  if (!categoryIds.length) return [];
  return [{
    categoryIds,
    source: 'knowledge_catalog',
    strength: 'verified',
    value: [match.canonicalName, match.canonicalModel].filter(Boolean).join(' ').slice(0, 240)
  }];
}
