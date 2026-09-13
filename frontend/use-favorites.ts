import { useCallback, useEffect, useRef, useState } from "react";
import { FAVORITES_KEY, parseFavoriteStorage } from "./favorites.js";
import type { FavoriteProduct } from "./favorites.js";
import { isProductSearchItem } from "./api-client.js";
import { changeFavoriteStorage, readFavorites, withFavoriteLock } from "./favorite-storage.js";
import type { FavoriteChange } from "./favorite-storage.js";
import { readPreference } from "./public-ui-state.js";
import type { DisplayProduct } from "./types.js";

interface FavoriteNotice {
  text: string;
  undo?: () => void;
  error?: boolean;
}

export function useFavorites(products: DisplayProduct[]) {
  const [favorites, setFavorites] = useState(() =>
    parseFavoriteStorage(readPreference(FAVORITES_KEY), isProductSearchItem),
  );
  const favoritesRef = useRef(favorites);
  const [notice, setNotice] = useState<FavoriteNotice | null>(null);
  const receive = useCallback((next: typeof favorites) => {
    favoritesRef.current = next;
    setFavorites(next);
  }, []);

  useEffect(() => {
    const update = (event: StorageEvent) => {
      if (event.key !== FAVORITES_KEY && event.key !== null) return;
      receive(parseFavoriteStorage(readPreference(FAVORITES_KEY), isProductSearchItem));
    };
    window.addEventListener("storage", update);
    return () => window.removeEventListener("storage", update);
  }, [receive]);

  const change = useCallback(
    async (intent: FavoriteChange) => {
      try {
        await withFavoriteLock(() => receive(changeFavoriteStorage(localStorage, intent)));
        return true;
      } catch {
        setNotice({
          text: "お気に入りを保存できませんでした。ブラウザーの保存容量・設定を確認して、もう一度お試しください。",
          error: true,
        });
        return false;
      }
    },
    [receive],
  );

  const refreshFavoriteSnapshots = useCallback(
    (items: FavoriteProduct[]) => {
      if (items.some((product) => favoritesRef.current.products.has(product.key)))
        void change({ kind: "refresh", products: items });
    },
    [change],
  );

  const toggleFavorite = useCallback(
    (key: string) => {
      // Intent comes from the rendered button. The mutation itself re-reads under the lock.
      const removed = favoritesRef.current.products.get(key);
      const product = products.find((candidate) => candidate.key === key);
      if (!removed && !product) return;
      void change(removed ? { kind: "remove", key } : { kind: "add", product: product! }).then(
        (saved) => {
          if (!saved) return;
          setNotice(
            removed
              ? {
                  text: "お気に入りから削除しました。",
                  undo: () => {
                    void change({ kind: "add", product: removed }).then((restored) => {
                      if (restored) setNotice({ text: "お気に入りに戻しました。" });
                    });
                  },
                }
              : { text: "お気に入りに追加しました。この端末のブラウザーに保存されます。" },
          );
        },
      );
    },
    [change, products],
  );

  // Returning to a suspended tab must also reflect writes whose storage event was delayed.
  useEffect(() => {
    const update = () => {
      if (document.visibilityState !== "visible") return;
      try {
        receive(readFavorites(localStorage));
      } catch {
        /* Keep the readable snapshot. */
      }
    };
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [receive]);

  return { favorites, notice, setNotice, toggleFavorite, refreshFavoriteSnapshots };
}
