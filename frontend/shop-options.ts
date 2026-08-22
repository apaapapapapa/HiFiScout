/** Minimal shape needed to order one shop filter option. */
export interface ShopFilterOption {
  key: string;
  name: string;
}

/**
 * Japanese gojuon readings used only to order the shop search filter.
 *
 * Display names intentionally stay unchanged. Keep this map exhaustive: the unit test compares it
 * with the registered shop plugins so a newly added shop cannot silently fall back to Latin or
 * kanji code-point ordering.
 */
export const SHOP_FILTER_READINGS: Readonly<Record<string, string>> = Object.freeze({
  avac: "あばっく",
  afroaudio: "あふろおーでぃお",
  ippinkan: "いっぴんかん",
  audiounion: "おーでぃおゆにおん",
  osakaya: "きゃびんおおさかや",
  soundpit: "さうんどぴっと",
  shimamusen: "しまむせん",
  "dynamic-audio": "だいなみっくおーでぃお",
  hifido: "はいふぁいどう",
  formusic: "ふぉーみゅーじっく",
  "fujiya-avic": "ふじやえーびっく",
  "u-audio": "ゆーおーでぃお",
});

const JAPANESE_READING_COLLATOR = new Intl.Collator("ja", {
  usage: "sort",
  sensitivity: "base",
});

/** Return a copy ordered by the Japanese reading while preserving each shop's display label. */
export function sortShopsByJapaneseReading<T extends ShopFilterOption>(shops: readonly T[]): T[] {
  return [...shops].sort((left, right) => {
    const leftReading = SHOP_FILTER_READINGS[left.key] || left.name;
    const rightReading = SHOP_FILTER_READINGS[right.key] || right.name;
    return (
      JAPANESE_READING_COLLATOR.compare(leftReading, rightReading) ||
      JAPANESE_READING_COLLATOR.compare(left.name, right.name) ||
      left.key.localeCompare(right.key)
    );
  });
}
