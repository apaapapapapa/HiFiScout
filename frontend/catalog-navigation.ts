import { filterUrlParams } from "./filters.js";
import type { ProductFilters } from "./filters.js";

const STATE_KEY = "hifiscoutCatalogPosition";
export interface CatalogPosition {
  filters: string;
  page: number;
  scrollY: number | null;
  focusKey: string | null;
  focusIndex: number | null;
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
    (value.scrollY !== null &&
      (typeof value.scrollY !== "number" ||
        !Number.isFinite(value.scrollY) ||
        value.scrollY < 0)) ||
    (value.focusKey !== null && typeof value.focusKey !== "string") ||
    (value.focusIndex !== null &&
      (typeof value.focusIndex !== "number" ||
        !Number.isSafeInteger(value.focusIndex) ||
        value.focusIndex < 0))
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
    scrollY: previous?.page === page ? previous.scrollY : null,
    focusKey: previous?.page === page ? previous.focusKey : null,
    focusIndex: previous?.page === page ? previous.focusIndex : null,
  };
  history.replaceState({ ...record(history.state), [STATE_KEY]: position }, "");
}

/** Capture before the detail route is pushed, so Back restores its originating list entry. */
export function captureCatalogPosition(
  focusKey: string | null = null,
  trigger: HTMLElement | null = null,
): void {
  const value = record(record(history.state)[STATE_KEY]);
  if (typeof value.filters !== "string") return;
  const previous = catalogPosition(history.state, value.filters);
  if (!previous) return;
  const focusIndex = trigger
    ? [...document.querySelectorAll<HTMLElement>("[data-offers]")]
        .filter((element) => element.dataset.offers === focusKey)
        .indexOf(trigger)
    : null;
  history.replaceState(
    {
      ...record(history.state),
      [STATE_KEY]: { ...previous, scrollY: window.scrollY, focusKey, focusIndex },
    },
    "",
  );
}

export function restoreCatalogPosition(position: CatalogPosition | null): void {
  if (!position || position.scrollY === null || location.pathname !== "/") return;
  const scrollY = position.scrollY;
  const expectedUrl = location.href;
  // React commits the restored page before the next paint. Fence rapid Back/Forward transitions.
  requestAnimationFrame(() =>
    requestAnimationFrame(() => {
      if (location.href !== expectedUrl) return;
      const trigger = [...document.querySelectorAll<HTMLElement>("[data-offers]")].filter(
        (element) => element.dataset.offers === position.focusKey,
      )[position.focusIndex ?? 0];
      trigger?.focus({ preventScroll: true });
      window.scrollTo({ top: scrollY, behavior: "instant" });
    }),
  );
}
