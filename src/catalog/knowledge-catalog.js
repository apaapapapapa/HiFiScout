function clean(value = '') {
  return String(value).normalize('NFKC').trim();
}

export function normalizeCatalogModel(value = '') {
  return clean(value)
    .toUpperCase()
    .replace(/[\s\u3000._・･\/\\‐‑‒–—―－-]+/g, '');
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

export function buildKnowledgeCatalogCandidateAggregates(rows = []) {
  const grouped = new Map();

  for (const row of rows) {
    const key = knowledgeCatalogKey(row?.manufacturer_id, row?.model);
    if (!key) continue;
    const normalizedModel = normalizeCatalogModel(row.model);
    let candidate = grouped.get(key);
    if (!candidate) {
      candidate = {
        key,
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
      grouped.set(key, candidate);
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
