import type {
  CandidatePriorityInput,
  CategoryEvidenceInput,
  KnowledgeCatalogCandidateAccumulator,
  KnowledgeCatalogListingRow,
  KnowledgeCatalogMatch,
  ScoredKnowledgeCatalogCandidate,
} from "./types.js";

/** Evidence samples are capped so one popular group cannot grow an unbounded D1 row. */
const RAW_VARIANT_LIMIT = 10;
const SOURCE_URL_LIMIT = 5;

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").trim();
}

export function normalizeCatalogModel(value: unknown = ""): string {
  return clean(value)
    .toUpperCase()
    .replace(/[‐‑‒–—―－]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/\s*([./_-])\s*/g, "$1")
    .trim();
}

function addLookupVariant(target: Set<string>, value: string): string {
  const normalized = normalizeCatalogModel(value);
  if (normalized) target.add(normalized);
  return normalized;
}

function stripListingAnnotations(value: string = ""): string {
  return clean(value)
    .replace(/\s*《[^》]{1,40}》\s*/g, " ")
    .replace(/\s*【[^】]*(?:販売済|売約|SOLD(?:\s*OUT)?|売切|品切)[^】]*】\s*$/gi, "")
    .replace(/\s*\[[A-Z0-9][A-Z0-9._/-]{3,}\]\s*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripPresentationVariant(value: string = ""): string {
  return clean(value)
    .replace(
      /\s*\/\s*(?:ブラック|ホワイト|シルバー|ゴールド|レッド|ブルー|ブラウン|黒|白|銀|black|white|silver|gold)(?:\s*[（(]?(?:ペア|pair)[）)]?)?\s*$/i,
      "",
    )
    .replace(/\s*[（(](?:B|S|BK|WH|W|K|ブラック|ホワイト|シルバー|黒|白|銀)[）)]\s*$/i, "")
    .trim();
}

function stripManufacturerMarketSuffix(value: string, manufacturerId: string): string {
  const normalized = normalizeCatalogModel(value);
  if (manufacturerId === "denon") {
    if (/^(?:AH|AVR|AVC|DCD|DHT|DNP|DP|PMA|RCD)-/i.test(normalized)) {
      const withoutColor = normalized.replace(/-(?:BK|SP|K|W|WH)$/i, "");
      if (withoutColor !== normalized) return withoutColor;
    }
    if (/^AH-[A-Z0-9-]+EM$/i.test(normalized)) return normalized.replace(/EM$/i, "");
  }
  if (manufacturerId === "marantz") {
    // Japanese retailers append market/color codes such as /FB and /FN to models whose
    // manufacturer identity is published without that suffix (for example SACD10/FB -> SACD 10).
    const withoutMarketSuffix = normalized.replace(/\/F(?:B|N)$/i, "");
    if (withoutMarketSuffix !== normalized) return withoutMarketSuffix;
  }
  return normalized;
}

function addManufacturerFormattingAliases(
  target: Set<string>,
  value: string,
  manufacturerId: string,
): void {
  const normalized = normalizeCatalogModel(value);
  if (!normalized || manufacturerId !== "marantz") return;
  // Marantz publishes several current families with a word/number boundary while retailers often
  // collapse it. Keep this manufacturer-scoped so unrelated model numbers remain exact identities.
  const match = normalized.match(/^(SACD|CD|MODEL|AV|AMP|LINK)(\d+[A-Z]*)$/i);
  if (match) addLookupVariant(target, `${match[1]} ${match[2]}`);
}

/**
 * Produces conservative lookup aliases for official-source verification without changing the
 * persisted catalog identity. Listing-only annotations such as colors, retailer SKUs and sold
 * markers may be removed, while meaningful revisions (SE/X/XD/MKII/Pro/Limited) are preserved.
 */
export function catalogModelLookupVariants({
  manufacturerId = "",
  model = "",
}: { manufacturerId?: string; model?: string } = {}): string[] {
  const manufacturer = clean(manufacturerId).toLowerCase();
  const variants = new Set<string>();
  const original = clean(model);
  if (!original) return [];

  addLookupVariant(variants, original);
  let simplified = stripListingAnnotations(original);
  addLookupVariant(variants, simplified);

  simplified = stripPresentationVariant(simplified);
  addLookupVariant(variants, simplified);

  const marketStripped = stripManufacturerMarketSuffix(simplified, manufacturer);
  addLookupVariant(variants, marketStripped);
  addManufacturerFormattingAliases(variants, marketStripped, manufacturer);

  // A seller may describe a base product bundled with an optional board, e.g. C-2800+AD-290V.
  // The complete listing identity remains intact, but the base product is a valid verification key.
  const plusIndex = marketStripped.indexOf("+");
  if (plusIndex > 0) addLookupVariant(variants, marketStripped.slice(0, plusIndex));

  return [...variants].sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
}

export function knowledgeCatalogKey(manufacturerId: unknown = "", model: unknown = ""): string {
  const manufacturer = clean(manufacturerId).toLowerCase();
  const normalizedModel = normalizeCatalogModel(model);
  return manufacturer && normalizedModel ? `${manufacturer}:${normalizedModel}` : "";
}

function parseCategoryIds(value: string | readonly string[] | undefined): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => Boolean(item));
  try {
    const parsed: unknown = JSON.parse(typeof value === "string" ? value : "[]");
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string" && Boolean(item))
      : [];
  } catch {
    return [];
  }
}

function earlier(left: string, right: string | undefined): string {
  if (!left) return right || "";
  if (!right) return left;
  return left < right ? left : right;
}

function later(left: string, right: string | undefined): string {
  if (!left) return right || "";
  if (!right) return left;
  return left > right ? left : right;
}

/**
 * Impact, not novelty. A group that leaves many listings unclassified or outside a canonical
 * product ranks above a one-off unknown item, and cross-shop repetition is a tie-breaking signal
 * rather than evidence of identity.
 */
export function candidatePriority({
  unclassifiedCount = 0,
  otherCount = 0,
  unresolvedIdentityCount = 0,
  shopCount = 0,
  listingCount = 0,
}: CandidatePriorityInput = {}): number {
  return (
    Number(unclassifiedCount) * 100 +
    Number(otherCount) * 80 +
    Number(unresolvedIdentityCount) * 40 +
    Number(shopCount) * 10 +
    Math.min(Number(listingCount), 9)
  );
}

/** Keeps one candidate row small enough to stay a bounded D1 aggregate. */
function addBounded(target: Set<string>, value: unknown, limit: number): void {
  const text = clean(value);
  if (!text || target.size >= limit) return;
  target.add(text);
}

function dominantReason(reasons: ReadonlyMap<string, number>): string {
  let dominant = "";
  let best = 0;
  for (const [reason, count] of [...reasons].sort((left, right) =>
    left[0].localeCompare(right[0]),
  )) {
    if (count <= best) continue;
    dominant = reason;
    best = count;
  }
  return dominant;
}

export function accumulateKnowledgeCatalogCandidateRows(
  grouped: Map<string, KnowledgeCatalogCandidateAccumulator> | undefined,
  rows: readonly KnowledgeCatalogListingRow[] = [],
): Map<string, KnowledgeCatalogCandidateAccumulator> {
  const target = grouped ?? new Map<string, KnowledgeCatalogCandidateAccumulator>();
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
        rawModelVariants: new Set(),
        sourceUrls: new Set(),
        identityRejectionReasons: new Map(),
        unclassifiedCount: 0,
        otherCount: 0,
        unresolvedIdentityCount: 0,
        firstSeenAt: "",
        lastSeenAt: "",
      };
      target.set(key, candidate);
    }

    candidate.listingCount += 1;
    if (row.shop_key) candidate.shops.add(String(row.shop_key));
    const categoryIds = parseCategoryIds(row.category_ids);
    for (const categoryId of categoryIds) candidate.categories.add(categoryId);
    // Empty raw evidence is still evidence that the seller supplied no model. Never manufacture a
    // raw variant from the title-derived display model during remediation aggregation.
    addBounded(candidate.rawModelVariants, row.raw_model, RAW_VARIANT_LIMIT);
    addBounded(candidate.sourceUrls, row.source_url, SOURCE_URL_LIMIT);
    // A listing with no resolution row is as unresolved as an explicit `unresolved` row; both are
    // work the remediation loop still owes the catalog.
    if (row.identity_status !== "matched") {
      candidate.unresolvedIdentityCount += 1;
      const reason = clean(row.identity_match_method) || "missing_resolution";
      candidate.identityRejectionReasons.set(
        reason,
        (candidate.identityRejectionReasons.get(reason) || 0) + 1,
      );
    }
    if (row.classification_status !== "classified") {
      candidate.unclassifiedCount += 1;
      if (row.title) candidate.sampleTitle = clean(row.title);
    } else if (categoryIds.includes("other")) {
      // A remaining legacy `other` is migration residue and stays high-priority until replay or
      // official evidence places it in a v3 product type (or the internal sentinel).
      candidate.otherCount += 1;
    }
    candidate.firstSeenAt = earlier(candidate.firstSeenAt, row.first_seen_at);
    candidate.lastSeenAt = later(candidate.lastSeenAt, row.last_seen_at);
  }
  return target;
}

export function finalizeKnowledgeCatalogCandidateAggregates(
  grouped: ReadonlyMap<string, KnowledgeCatalogCandidateAccumulator> = new Map(),
): ScoredKnowledgeCatalogCandidate[] {
  return [...grouped.values()]
    .map((candidate) => {
      const shopCount = candidate.shops.size;
      const result = {
        manufacturerId: candidate.manufacturerId,
        normalizedModel: candidate.normalizedModel,
        observedManufacturer: candidate.observedManufacturer,
        observedModel: candidate.observedModel,
        sampleTitle: candidate.sampleTitle,
        categoryIds: [...candidate.categories].sort(),
        rawModelVariants: [...candidate.rawModelVariants].sort(),
        sourceUrls: [...candidate.sourceUrls].sort(),
        identityRejectionReason: dominantReason(candidate.identityRejectionReasons),
        listingCount: candidate.listingCount,
        shopCount,
        unclassifiedCount: candidate.unclassifiedCount,
        otherCount: candidate.otherCount,
        unresolvedIdentityCount: candidate.unresolvedIdentityCount,
        firstSeenAt: candidate.firstSeenAt,
        lastSeenAt: candidate.lastSeenAt,
      };
      return { ...result, priorityScore: candidatePriority(result) };
    })
    .sort(
      (left, right) =>
        right.priorityScore - left.priorityScore ||
        right.listingCount - left.listingCount ||
        left.manufacturerId.localeCompare(right.manufacturerId) ||
        left.normalizedModel.localeCompare(right.normalizedModel),
    );
}

export function buildKnowledgeCatalogCandidateAggregates(
  rows: readonly KnowledgeCatalogListingRow[] = [],
): ScoredKnowledgeCatalogCandidate[] {
  return finalizeKnowledgeCatalogCandidateAggregates(
    accumulateKnowledgeCatalogCandidateRows(
      new Map<string, KnowledgeCatalogCandidateAccumulator>(),
      rows,
    ),
  );
}

export function knowledgeCatalogEvidence(
  match: Partial<KnowledgeCatalogMatch> | null | undefined,
): CategoryEvidenceInput[] {
  const categoryIds = Array.isArray(match?.categoryIds) ? match.categoryIds.filter(Boolean) : [];
  if (!categoryIds.length) return [];
  return [
    {
      categoryIds,
      source: "knowledge_catalog",
      strength: "verified",
      value: [match?.canonicalName, match?.canonicalModel].filter(Boolean).join(" ").slice(0, 240),
    },
  ];
}
