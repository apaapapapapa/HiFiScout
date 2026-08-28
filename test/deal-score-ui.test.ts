import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

const publicApp = readFileSync(new URL("../frontend/public-app.tsx", import.meta.url), "utf8");

test("public sort control exposes the persisted deal-score ordering", () => {
  assert.match(publicApp, /<option value="dealScore">相場より割安な順<\/option>/);
});
