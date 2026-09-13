import type { ProductFilters } from "./filters.js";
import type { DisplayProduct } from "./types.js";

export interface ProductFilter {
  field: "manufacturer" | "category";
  value: string;
}

export interface ProductFilterNavigation {
  href: (filter: ProductFilter) => string;
  select: (filter: ProductFilter) => void;
}

export function applyProductFilter(filters: ProductFilters, filter: ProductFilter): ProductFilters {
  return {
    ...filters,
    [filter.field]: filter.field === "manufacturer" ? [filter.value] : filter.value,
  };
}

type FilterLinkClick = Pick<
  MouseEvent,
  "defaultPrevented" | "button" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey" | "preventDefault"
>;

function followProductFilterLink(
  event: FilterLinkClick,
  filter: ProductFilter,
  navigation?: ProductFilterNavigation,
): void {
  if (
    !navigation ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey
  )
    return;
  event.preventDefault();
  navigation.select(filter);
}

/** Cached product documents are outside the React root. Enhance their neutral links with the
 * visitor's current filters without putting query-specific state into the shared HTML cache. */
export function enhanceProductFilterLinks(
  container: HTMLElement,
  navigation: ProductFilterNavigation,
): () => void {
  const cleanups = [
    ...container.querySelectorAll<HTMLAnchorElement>(
      "a[data-manufacturer-filter], a[data-category-filter]",
    ),
  ].map((link) => {
    const filter: ProductFilter = link.dataset.manufacturerFilter
      ? { field: "manufacturer", value: link.dataset.manufacturerFilter }
      : { field: "category", value: link.dataset.categoryFilter || "" };
    link.href = navigation.href(filter);
    const onClick = (event: MouseEvent) => followProductFilterLink(event, filter, navigation);
    link.addEventListener("click", onClick);
    return () => link.removeEventListener("click", onClick);
  });
  return () => cleanups.forEach((cleanup) => cleanup());
}

function ProductFilterLink({
  field,
  value,
  label,
  className,
  navigation,
}: ProductFilter & {
  label: string;
  className: string;
  navigation?: ProductFilterNavigation;
}) {
  if (!value) return <span className={className}>{label}</span>;
  const filter = { field, value };
  return (
    <a
      className={`${className} product-filter-link`}
      href={navigation?.href(filter) ?? `/?${new URLSearchParams({ [field]: value })}`}
      data-manufacturer-filter={field === "manufacturer" ? value : undefined}
      data-category-filter={field === "category" ? value : undefined}
      title={`${label}の商品に絞り込む`}
      aria-label={`${label}の商品に絞り込む`}
      onClick={(event) => followProductFilterLink(event, filter, navigation)}
    >
      {label}
    </a>
  );
}

export function ManufacturerFilterLink({
  manufacturer,
  navigation,
}: {
  manufacturer: string;
  navigation?: ProductFilterNavigation;
}) {
  const label = manufacturer.trim() || "メーカー不明";
  return (
    <ProductFilterLink
      field="manufacturer"
      value={label === "メーカー不明" ? "" : label}
      label={label}
      className="manufacturer-filter-link"
      navigation={navigation}
    />
  );
}

export function ProductCategoryLinks({
  product,
  navigation,
}: {
  product: DisplayProduct;
  navigation?: ProductFilterNavigation;
}) {
  // Keep each label paired with its wire ID before omitting empty labels. Older favorite
  // snapshots can lack direct categories; only their known primary category is linkable.
  const categories = product.direct_categories?.some(Boolean)
    ? product.direct_categories.map((label, index) => ({
        label,
        id:
          product.direct_category_ids?.[index] ||
          (label === product.category ? product.primary_category_id : ""),
      }))
    : [{ label: product.category || "カテゴリ不明", id: product.primary_category_id }];
  return (
    <>
      {categories
        .filter(({ label }) => label)
        .map(({ id, label }, index) => (
          <ProductFilterLink
            key={`${id}-${index}`}
            field="category"
            value={label === "カテゴリ不明" ? "" : id}
            label={label}
            className="category"
            navigation={navigation}
          />
        ))}
    </>
  );
}
