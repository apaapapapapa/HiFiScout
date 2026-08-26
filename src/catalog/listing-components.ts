/**
 * Component products inside one selling unit, and the category set that follows from them.
 *
 * A listing is one sale, not one product: `Grandioso P1 + Grandioso D1` is a transport and a DAC
 * sold together. Collapsing that to a single representative category loses it everywhere — the
 * card, category search, parent-category search and the facet counts.
 *
 * This module answers only the canonical question — *which distinct products is this listing, and
 * which categories do they belong to* — and leaves storage, projection and presentation to their
 * own layers. Shop adapters extract seller evidence; none of them get a private idea of what a set
 * is.
 */

import {
  canonicalCategoryDefinitions,
  categoryClosureIds,
  categoryIdForFilter,
  categorySearchAliases,
  getCategory,
} from "./categories.js";
import { UNCLASSIFIED_CATEGORY_ID } from "./categories.js";
import { inferExplicitCategoryIds } from "./category-rules.js";
import { resolveModel } from "./model-resolver.js";
import type {
  CategoryClassification,
  CategoryId,
  ClassificationReason,
  ClassificationSource,
  ClassificationState,
  ClassificationStatus,
} from "./types.js";

/**
 * Characters a seller may put between two products.
 *
 * Candidates only. A separator is evidence of a *possible* boundary and nothing more: `TELOS2500+`
 * is one model whose name ends in `+`, and `DAC搭載プリメインアンプ` is one product that happens to
 * name a second category. What promotes a candidate to a boundary is both sides independently
 * resolving to a model identity, which is checked below.
 */
const BOUNDARY_PATTERN = /[+＋/／&＆・]|セット/gu;

/** One product detected inside a listing. */
export interface ListingComponent {
  /** The seller text this component was read from, unmodified. */
  segment: string;
  /**
   * The text to read this component's *category* from, which is not always {@link segment}.
   *
   * Several adapters extract a concise model field — `Grandioso P1 + Grandioso D1` — and that is
   * the better source for identity precisely because it carries no prose. But the category words
   * live in the prose: the title says `Grandioso P1 SACDトランスポート + Grandioso D1 DAC`. So a
   * component is identified from the model and classified from the matching stretch of title,
   * falling back to its own segment when no stretch matches.
   */
  categorySegment: string;
  model: string;
  normalizedModel: string;
}

export interface ListingComponentDetection {
  /** True only when two or more distinct component identities were established. */
  isBundle: boolean;
  components: ListingComponent[];
}

export interface ListingComponentInput {
  /** Seller model evidence, preferred over the title because it carries less prose. */
  rawModel?: string;
  model?: string;
  title?: string;
}

export interface ListingComponentContext {
  manufacturerId?: string;
  shopKey?: string;
}

function componentSource({ rawModel, model, title }: ListingComponentInput): string {
  return String(rawModel || model || title || "").trim();
}

/** Case- and width-insensitive, so a model written differently in the title still matches. */
function matchKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/gu, "").toLowerCase();
}

/**
 * The stretch of title a component was named in, or `""` when the title does not name it.
 *
 * A title segment is claimed by at most one component, so two components cannot both be classified
 * from the same words.
 */
function titleSegmentFor(segment: string, titleSegments: string[]): string {
  const key = matchKey(segment);
  if (!key) return "";
  const index = titleSegments.findIndex(
    (candidate) => candidate && matchKey(candidate).includes(key),
  );
  if (index < 0) return "";
  const matched = titleSegments[index];
  titleSegments[index] = "";
  return matched;
}

/**
 * Whether one segment stands on its own as a product identity.
 *
 * Three things have to hold, and each rejects a different false positive:
 *
 * - a category word is not a product. `DAC` resolves as a model happily, so `X / DAC` would look
 *   like a set without this; the taxonomy is asked first and anything it recognises is a category.
 * - the model resolver must actually resolve it. `元箱付き`, `ケーブル付き` and `リモコン` come back
 *   unresolved with an empty identity, which is what keeps an accessory mention from becoming a
 *   component, and `DAC搭載プリメインアンプ` comes back as a candidate rather than resolved.
 * - the identity must be non-empty, so a segment that resolves to nothing cannot be counted.
 */
function componentIdentity(
  segment: string,
  { manufacturerId, shopKey }: ListingComponentContext,
): ListingComponent | null {
  const trimmed = segment.trim();
  if (!trimmed) return null;
  if (categoryIdForFilter(trimmed)) return null;

  const resolved = resolveModel({
    rawModel: trimmed,
    title: trimmed,
    manufacturerId: manufacturerId || "",
    shopKey,
  });
  if (resolved.status !== "resolved" || !resolved.normalizedModel) return null;
  return {
    segment: trimmed,
    categorySegment: trimmed,
    model: resolved.model,
    normalizedModel: resolved.normalizedModel,
  };
}

/**
 * The distinct products a listing sells, or nothing when it sells one.
 *
 * Components are reported only for a set. An ordinary listing already has a model and a category
 * from the single-product pipeline, and re-deriving them here would mean two answers to the same
 * question — and a worse one, because a split made for a set cuts a lone model like `TELOS2500+`
 * in the wrong place. Two mentions of the same model are one product described twice, not a pair.
 */
export function detectListingComponents(
  input: ListingComponentInput,
  context: ListingComponentContext = {},
): ListingComponentDetection {
  const source = componentSource(input);
  if (!source) return { isBundle: false, components: [] };

  const segments = source.split(BOUNDARY_PATTERN);
  // Most listings name one product and carry no separator at all. Leaving before the resolver runs
  // keeps this pass off the hot path for them rather than paying an extra resolution per crawl.
  if (segments.length < 2) return { isBundle: false, components: [] };

  const title = String(input.title || "").trim();
  // Consumed as components claim them, so the same words cannot classify two products.
  const titleSegments = title && title !== source ? title.split(BOUNDARY_PATTERN) : [];
  const components: ListingComponent[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const component = componentIdentity(segment, context);
    if (!component || seen.has(component.normalizedModel)) continue;
    seen.add(component.normalizedModel);
    components.push({
      ...component,
      categorySegment: titleSegmentFor(component.segment, titleSegments) || component.segment,
    });
  }

  if (components.length < 2) return { isBundle: false, components: [] };
  return { isBundle: true, components };
}

const CANONICAL_ORDER = new Map<string, number>(
  canonicalCategoryDefinitions().map((category, index) => [category.id, index]),
);

/**
 * The categories a listing should display and be filtered by, from its components' classifications.
 *
 * Order comes from the canonical taxonomy rather than from the order components were parsed, read
 * out of SQLite, or replayed in, so the same listing renders identically every time.
 *
 * `unclassified` is a statement that nothing is known, which stops being true as soon as one
 * component is classified — so it survives only when no component was.
 */
export function directCategoryIds(categoryIds: readonly string[]): CategoryId[] {
  const classified = new Set<CategoryId>();
  let sawUnclassified = false;

  for (const value of categoryIds) {
    const category = getCategory(value);
    if (!category) continue;
    // The sentinel is deliberately not `classifiable`, so it is recognised before that gate.
    if (category.id === UNCLASSIFIED_CATEGORY_ID) {
      sawUnclassified = true;
      continue;
    }
    if (!category.classifiable) continue;
    classified.add(category.id);
  }

  if (!classified.size) return sawUnclassified ? [UNCLASSIFIED_CATEGORY_ID] : [];
  return [...classified].sort(byCanonicalOrder);
}

function byCanonicalOrder(left: CategoryId, right: CategoryId): number {
  return (CANONICAL_ORDER.get(left) ?? 0) - (CANONICAL_ORDER.get(right) ?? 0);
}

/**
 * The category each component names in its own seller text, one entry per component.
 *
 * A component that names none contributes the `unclassified` sentinel rather than nothing, so
 * "no component said anything" stays distinguishable from "one component was classified and the
 * rest were silent" — {@link directCategoryIds} then drops the sentinel in the second case.
 */
export function componentCategoryIds(components: readonly ListingComponent[]): CategoryId[] {
  return components.map(
    (component) =>
      inferExplicitCategoryIds(component.categorySegment, { context: "title" })[0] ||
      UNCLASSIFIED_CATEGORY_ID,
  );
}

/**
 * The categories a listing is *directly* in: what its card shows and what a category filter matches.
 *
 * Components decide it when they can. When they cannot — an ordinary single-product listing, or a
 * set whose components name no category of their own — the listing classification the existing
 * pipeline already produced decides instead. That fallback is what keeps every non-set listing
 * exactly as it is today: with no components, this returns `[primaryCategoryId]` and nothing
 * downstream can tell the difference.
 */
export function listingDirectCategoryIds(
  componentCategories: readonly string[],
  primaryCategoryId: string,
): CategoryId[] {
  const fromComponents = directCategoryIds(componentCategories);
  const anyClassified = fromComponents.some((id) => id !== UNCLASSIFIED_CATEGORY_ID);
  return anyClassified ? fromComponents : directCategoryIds([primaryCategoryId]);
}

/**
 * Every category id whose filter must match this listing: each direct category and its ancestors.
 *
 * The union is taken once across the whole set, so a parent two components share is one membership
 * and not two — a transport plus a DAC is a single `digital` listing, which is what stops the
 * shared parent's facet from counting the same card twice.
 *
 * Not yet called with more than one direct category. Widening the stored membership before the
 * category *filter* reads it would make a set contribute to a facet it then disappears from when
 * that facet is selected — the count and the results have to start disagreeing never, so both move
 * in the slice that teaches search to read membership. See {@link listingMembershipCategoryIds}.
 */
export function listingCategoryClosureIds(directIds: readonly string[]): CategoryId[] {
  const closure = new Set<CategoryId>();
  for (const directId of directIds) {
    for (const ancestorId of categoryClosureIds(directId)) closure.add(ancestorId);
  }
  return [...closure].sort(byCanonicalOrder);
}

/**
 * The single representative category the pre-existing contract still needs.
 *
 * Kept deterministic in both directions: a primary that is still one of the direct categories
 * survives, so re-reading a listing never reshuffles its representative category, and when the
 * listing classification named something the components did not, the canonical taxonomy picks the
 * replacement rather than parse order. For a listing with one direct category — every non-set
 * listing — this returns that category, which is the primary it already had.
 */
export function listingPrimaryCategoryId(
  directIds: readonly CategoryId[],
  primaryCategoryId: string,
): CategoryId {
  if (directIds.includes(primaryCategoryId as CategoryId)) return primaryCategoryId as CategoryId;
  return directIds[0] ?? UNCLASSIFIED_CATEGORY_ID;
}

/**
 * A listing's category fields once its components have had their say.
 *
 * Every field a writer needs to persist, produced in one place because there are two writers: the
 * crawl path and the data-quality replay. Deriving this twice is how the two would drift, and a
 * replay that recomputed the classification but not the set would leave rows whose stored primary
 * is not one of their own categories.
 */
export interface ListingCategorySet {
  directCategoryIds: CategoryId[];
  primaryCategoryId: CategoryId;
  /** The single-product classification result. Unchanged unless the primary itself moved. */
  categoryIds: CategoryId[];
  displayName: string;
  classificationStatus: ClassificationStatus;
  classificationState: ClassificationState;
  classificationReason: ClassificationReason;
  classificationSource: ClassificationSource;
  searchAliases: string;
  /** True when the components named categories the listing-level classification did not. */
  promoted: boolean;
}

/**
 * Combine a listing classification with what its component products say about themselves.
 *
 * With no components — every listing that sells one product — this returns the classification
 * unchanged, field for field, with `directCategoryIds` holding the primary alone. That identity is
 * the whole safety argument for the change: a non-set listing cannot notice this function exists.
 */
export function listingCategorySet(
  classification: CategoryClassification,
  componentCategories: readonly string[],
): ListingCategorySet {
  const directIds = listingDirectCategoryIds(componentCategories, classification.primaryCategoryId);
  const primaryCategoryId = listingPrimaryCategoryId(directIds, classification.primaryCategoryId);
  const promoted = primaryCategoryId !== classification.primaryCategoryId;
  const promotedCategory = promoted ? getCategory(primaryCategoryId) : null;
  return {
    directCategoryIds: directIds,
    primaryCategoryId,
    categoryIds: promoted ? [primaryCategoryId] : classification.categoryIds,
    displayName: promotedCategory?.name ?? classification.displayName,
    classificationStatus: promoted ? "classified" : classification.classificationStatus,
    classificationState: promoted ? "classified" : classification.classificationState,
    classificationReason: promoted ? "" : classification.classificationReason,
    classificationSource: promoted ? "component_evidence" : classification.classificationSource,
    // Aliases for every direct category, so the second product in a set is searchable by the name
    // of its own category too. One direct category yields byte-identical aliases to today.
    searchAliases: directIds.length
      ? categorySearchAliases(directIds)
      : classification.searchAliases,
    promoted,
  };
}

/**
 * The categories a listing's `product_categories` rows should hold right now.
 *
 * Deliberately the closure of the representative category alone, which is exactly what this table
 * has held since 0013. `direct_category_ids` already records the real set, so the storage and the
 * semantics are in place; what is not in place yet is a reader. `src/db/product-search-repository.ts`
 * still filters `product_search_entities.primary_category_id`, and `src/http/meta.ts` counts facets
 * from this table — so widening this alone would make a set listing add itself to the DAC facet and
 * then vanish when a user clicked it. Requirement 8 of #376 asks for the opposite: the count and
 * the filtered results must agree.
 *
 * The one edit that lands the set is here, together with the search-side change that reads it.
 */
export function listingMembershipCategoryIds(
  primaryCategoryId: string,
  _directCategoryIds: readonly string[],
): CategoryId[] {
  return listingCategoryClosureIds([primaryCategoryId]);
}
