import test from "node:test";
import assert from "node:assert/strict";

import { relativeTime, safeDate } from "../frontend/format.js";

test("missing sync timestamps are not interpreted as the Unix epoch", () => {
  assert.equal(safeDate(null), null);
  assert.equal(relativeTime(null, Date.parse("2026-08-23T00:00:00.000Z")), "未取得");
});

test("invalid sync timestamps stay unavailable", () => {
  assert.equal(safeDate("not-a-date"), null);
  assert.equal(relativeTime("not-a-date", Date.parse("2026-08-23T00:00:00.000Z")), "未取得");
});
