import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import {
  MAX_WATCH_PREFERENCES,
  parseWatchPreferences,
  updateWatchPreference,
} from "../frontend/watch-preferences.js";

const AT = "2026-09-07T00:00:00Z";
test("watch planning preserves private notes, explicit zero prices and unchanged timestamps", () => {
  const first = updateWatchPreference([], "c-1", 125000, "ラック幅を再確認\nリモコン必須", AT)!;
  const restored = parseWatchPreferences(JSON.stringify(first));
  assert.deepEqual(restored, first);
  const noop = updateWatchPreference(
    first,
    "c-1",
    125000,
    first[0].note,
    "2026-09-08T00:00:00Z",
    AT,
  );
  assert.deepEqual(noop, first);
  const withListing = updateWatchPreference(first, "l-1", 0, "", AT)!;
  assert.equal(withListing.length, 2);
  assert.equal(withListing[1].targetPriceYen, 0);
  assert.deepEqual(updateWatchPreference(withListing, "c-1", null, "", AT, AT), [withListing[1]]);
  assert.equal(updateWatchPreference(first, "c-1", 90000, "stale draft", AT, null), null);
});

test("watch preferences enforce bounded valid keys, prices, notes and storage capacity", () => {
  for (const price of [-1, NaN, Infinity, 1.5, 1_000_000_000_000])
    assert.equal(updateWatchPreference([], "c-1", price, "", AT), null);
  assert.equal(updateWatchPreference([], "legacy-1", 100, "", AT), null);
  assert.equal(updateWatchPreference([], "c-1", null, "あ".repeat(1001), AT), null);
  assert.deepEqual(parseWatchPreferences("{oops"), []);
  assert.deepEqual(
    parseWatchPreferences(
      JSON.stringify([{ key: "c-1", targetPriceYen: "100", note: "", updatedAt: AT }]),
    ),
    [],
  );
  const full = Array.from({ length: MAX_WATCH_PREFERENCES }, (_, index) => ({
    key: `c-${index + 1}`,
    targetPriceYen: 100,
    note: "",
    updatedAt: AT,
  }));
  assert.equal(updateWatchPreference(full, "c-999", 100, "", AT), null);
  assert.equal(
    updateWatchPreference(full, "c-1", 200, "updated", AT)?.length,
    MAX_WATCH_PREFERENCES,
  );
});
