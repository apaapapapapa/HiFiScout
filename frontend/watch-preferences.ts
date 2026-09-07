import { validProductKey } from "./product-permalink.js";

export const WATCH_PREFERENCES_KEY = "hifiscout:watch-preferences:v1";
export const MAX_WATCH_PREFERENCES = 200;
export interface WatchPreference {
  key: string;
  targetPriceYen: number | null;
  note: string;
  updatedAt: string;
}

export function validTargetPrice(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 999_999_999_999)
  );
}

/** Only private planning data belongs here; never save seller descriptions or public relation audits. */
export function parseWatchPreferences(raw: string | null): WatchPreference[] {
  if (!raw || raw.length > 1_000_000) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!Array.isArray(data) || data.length > MAX_WATCH_PREFERENCES) return [];
    const entries = new Map<string, WatchPreference>();
    for (const item of data) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const row = item as Record<string, unknown>;
      if (
        typeof row.key !== "string" ||
        !validProductKey(row.key) ||
        !validTargetPrice(row.targetPriceYen) ||
        typeof row.note !== "string" ||
        [...row.note].length > 1000 ||
        typeof row.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(row.updatedAt))
      )
        continue;
      entries.set(row.key, {
        key: row.key,
        targetPriceYen: row.targetPriceYen,
        note: row.note,
        updatedAt: row.updatedAt,
      });
    }
    return [...entries.values()];
  } catch {
    return [];
  }
}

/** Null means the change was invalid or exceeded capacity; unchanged values retain decision time. */
export function updateWatchPreference(
  entries: readonly WatchPreference[],
  key: string,
  targetPriceYen: number | null,
  note: string,
  now = new Date().toISOString(),
  expectedUpdatedAt?: string | null,
): WatchPreference[] | null {
  if (!validProductKey(key) || !validTargetPrice(targetPriceYen) || [...note].length > 1000)
    return null;
  const current = entries.find((entry) => entry.key === key);
  if (expectedUpdatedAt !== undefined && (current?.updatedAt ?? null) !== expectedUpdatedAt)
    return null;
  if (current?.targetPriceYen === targetPriceYen && current.note === note) return [...entries];
  const next = entries.filter((entry) => entry.key !== key);
  if (targetPriceYen === null && !note) return next;
  if (next.length >= MAX_WATCH_PREFERENCES) return null;
  return [...next, { key, targetPriceYen, note, updatedAt: now }];
}
