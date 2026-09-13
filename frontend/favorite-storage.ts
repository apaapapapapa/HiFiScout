import { isProductSearchItem } from "./api-client.js";
import {
  FAVORITES_KEY,
  favoriteSnapshot,
  favoriteStoragePayload,
  parseFavoriteStorage,
} from "./favorites.js";
import type { FavoriteProduct, FavoriteStore } from "./favorites.js";

export type FavoriteChange =
  | { kind: "add"; product: FavoriteProduct }
  | { kind: "remove"; key: string }
  | { kind: "refresh"; products: FavoriteProduct[] };

/** Apply intent to the latest membership; a delayed refresh can never add a deleted favorite. */
export function applyFavoriteChange(current: FavoriteStore, change: FavoriteChange): FavoriteStore {
  const next: FavoriteStore = {
    products: new Map(current.products),
    legacyIds: new Set(current.legacyIds),
  };
  if (change.kind === "remove") next.products.delete(change.key);
  else if (change.kind === "add")
    next.products.set(change.product.key, favoriteSnapshot(change.product));
  else
    for (const product of change.products) {
      const previous = current.products.get(product.key);
      if (!previous) continue;
      const snapshot = favoriteSnapshot(product);
      // Unchanged search results need not discard the last complete offer observation. A changed
      // result invalidates it; incomplete knowledge is surfaced instead of proving a shop absent.
      if (
        !snapshot.favorite_offers &&
        previous.favorite_offers &&
        previous.latest_activity_at === product.latest_activity_at &&
        previous.offer_count === product.offer_count &&
        previous.in_stock_offer_count === product.in_stock_offer_count &&
        previous.lowest_price_yen === product.lowest_price_yen &&
        previous.highest_price_yen === product.highest_price_yen
      ) {
        snapshot.favorite_offers = previous.favorite_offers;
      }
      next.products.set(product.key, snapshot);
    }
  return next;
}

export function readFavorites(storage: Pick<Storage, "getItem">): FavoriteStore {
  return parseFavoriteStorage(storage.getItem(FAVORITES_KEY), isProductSearchItem);
}

/** The entire read/modify/write is synchronous inside the origin-wide Web Lock. */
export function changeFavoriteStorage(
  storage: Pick<Storage, "getItem" | "setItem">,
  change: FavoriteChange,
): FavoriteStore {
  const previous = storage.getItem(FAVORITES_KEY);
  const next = applyFavoriteChange(parseFavoriteStorage(previous, isProductSearchItem), change);
  const payload = JSON.stringify(favoriteStoragePayload(next));
  if (payload !== previous) storage.setItem(FAVORITES_KEY, payload);
  return next;
}

export async function withFavoriteLock<T>(action: () => T): Promise<T> {
  if (navigator.locks) return navigator.locks.request(FAVORITES_KEY, action);
  // Older browsers still re-read immediately before their synchronous write, with no await gap.
  return action();
}
