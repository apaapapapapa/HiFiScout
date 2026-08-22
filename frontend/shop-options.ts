/** Minimal shape needed to order one user-facing shop entry. */
export interface ShopFilterOption {
  key: string;
  name: string;
}

/**
 * Japanese gojuon readings shared by user-facing shop lists that need Japanese reading order.
 *
 * Display names intentionally stay unchanged. Keep this map exhaustive: the unit test compares it
 * with the registered shop plugins so every newly registered shop has an explicit reading instead
 * of silently falling back to Latin or kanji code-point ordering.
 */
export const SHOP_FILTER_READINGS: Readonly<Record<string, string>> = Object.freeze({
  avac: "あばっく",
  afroaudio: "あふろおーでぃお",
  ippinkan: "いっぴんかん",
  "audio-space-core": "おーでぃおすぺーすこあ",
  audiounion: "おーでぃおゆにおん",
  osakaya: "きゃびんおおさかや",
  "sound-support": "さうんどさぽーと",
  soundpit: "さうんどぴっと",
  shimamusen: "しまむせん",
  "dynamic-audio": "だいなみっくおーでぃお",
  tereon: "てれおん",
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
