import { FACET_DEFINITIONS } from "../src/api/contracts.js";
import type { FacetDefinition, FacetSelection, MetaResponse } from "../src/api/contracts.js";

/** UI suggestions only: changing category must never silently erase an applied predicate. */
export function visibleFacetOptions(
  category: string,
  selected: readonly FacetSelection[],
  meta: MetaResponse | null,
): FacetDefinition[] {
  const categories = meta?.categoryFacets ?? [];
  const parents = new Map(categories.map((value) => [value.id, value.parentId]));
  const selectedCategories = category
    ? (meta?.legacyCategoryAliases?.[category] ?? [category])
    : [];
  const applies = (scope: readonly string[]): boolean =>
    scope.length === 0 ||
    selectedCategories.some((id) =>
      scope.some(
        (allowed) => allowed === id || parents.get(id) === allowed || parents.get(allowed) === id,
      ),
    );

  return FACET_DEFINITIONS.flatMap((facet) => {
    const applicable = applies(facet.categoryIds ?? facet.categoryRootIds);
    const values = facet.values.filter(
      (value) =>
        (applicable && (!value.categoryIds || applies(value.categoryIds))) ||
        selected.some(
          (selection) => selection.facetId === facet.id && selection.value === value.id,
        ),
    );
    return values.length ? [{ ...facet, values }] : [];
  });
}
