import { filterUrlParams } from "./filters.js";
import type { ProductFilters } from "./filters.js";

const STATE_KEY = "hifiscoutCatalogPosition";
export interface CatalogPosition {
  filters: string;
  page: number;
  scrollY: number;
  focusKey: string | null;
}

export function catalogFilterKey(filters: ProductFilters): string {
  return `${filters.favoritesOnly ? "favorites" : "catalog"}|${filterUrlParams(filters, "list")}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function catalogPosition(state: unknown, filters: string): CatalogPosition | null {
  const value = record(record(state)[STATE_KEY]);
  if (
    value.filters !== filters ||
    !Number.isSafeInteger(value.page) ||
    Number(value.page) < 1 ||
    typeof value.scrollY !== "number" ||
    !Number.isFinite(value.scrollY) ||
    value.scrollY < 0 ||
    (value.focusKey !== null && typeof value.focusKey !== "string")
  )
    return null;
  return value as unknown as CatalogPosition;
}

export function recordCatalogPage(filters: ProductFilters, page: number): void {
  const key = catalogFilterKey(filters);
  const previous = catalogPosition(history.state, key);
  const position: CatalogPosition = {
    filters: key,
    page,
    scrollY: previous?.page === page ? previous.scrollY : 0,
    focusKey: previous?.page === page ? previous.focusKey : null,
  };
  history.replaceState({ ...record(history.state), [STATE_KEY]: position }, "");
}

/** Capture before the detail route is pushed, so Back restores its originating list entry. */
export function captureCatalogPosition(focusKey: string): void {
  const value = record(record(history.state)[STATE_KEY]);
  if (typeof value.filters !== "string") return;
  const previous = catalogPosition(history.state, value.filters);
  if (!previous) return;
  history.replaceState(
    { ...record(history.state), [STATE_KEY]: { ...previous, scrollY: window.scrollY, focusKey } },
    "",
  );
}

export function restoreCatalogPosition(position: CatalogPosition | null): void {
  if (!position || location.pathname !== "/") return;
  const expectedUrl = location.href;
  // React commits the restored page before the next paint. Fence rapid Back/Forward transitions.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (location.href !== expectedUrl) return;
      const trigger = [...document.querySelectorAll<HTMLElement>("[data-offers]")].find(
        (element) => element.dataset.offers === position.focusKey,
      );
      trigger?.focus({ preventScroll: true });
      window.scrollTo({ top: position.scrollY, behavior: "instant" });
    }),
  );
}
