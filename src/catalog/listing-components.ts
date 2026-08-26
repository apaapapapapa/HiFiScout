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

import { categoryIdForFilter, getCategory, canonicalCategoryDefinitions } from "./categories.js";
import { UNCLASSIFIED_CATEGORY_ID } from "./categories.js";
import { resolveModel } from "./model-resolver.js";
import type { CategoryId } from "./types.js";

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
  return { segment: trimmed, model: resolved.model, normalizedModel: resolved.normalizedModel };
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
  const components: ListingComponent[] = [];
  const seen = new Set<string>();
  for (const segment of segments) {
    const component = componentIdentity(segment, context);
    if (!component || seen.has(component.normalizedModel)) continue;
    seen.add(component.normalizedModel);
    components.push(component);
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
  return [...classified].sort(
    (left, right) => (CANONICAL_ORDER.get(left) ?? 0) - (CANONICAL_ORDER.get(right) ?? 0),
  );
}
