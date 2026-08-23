import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import { canonicalCategoryDefinitions, getCategory } from "../src/catalog/categories.js";

test("refined taxonomy exposes the requested headphone and power categories", () => {
  const headphoneCategories = canonicalCategoryDefinitions()
    .filter((category) => category.parentId === "headphone_group")
    .map((category) => [category.id, category.name]);

  assert.deepEqual(headphoneCategories, [
    ["wired_headphone", "有線ヘッドホン"],
    ["wired_earphone", "有線イヤホン"],
    ["btw_headphone", "BTWヘッドホン"],
    ["btw_earphone", "BTWイヤホン"],
  ]);

  const canonicalIds = new Set(canonicalCategoryDefinitions().map((category) => category.id));
  assert.equal(canonicalIds.has("headphone" as never), false);
  assert.equal(canonicalIds.has("earphone" as never), false);
  assert.equal(canonicalIds.has("power_accessory" as never), false);
  assert.equal(getCategory("power_strip")?.name, "電源タップ");
  assert.equal(getCategory("clean_power")?.name, "クリーン電源");
});

test("transport and step-up transformer are siblings of their source categories", () => {
  const player = getCategory("cd_sacd_player");
  const transport = getCategory("transport");
  assert.equal(player?.parentId, "digital");
  assert.equal(transport?.parentId, "digital");
  assert.equal(transport?.order, (player?.order ?? 0) + 1);

  const phonoEq = getCategory("phono_eq");
  const stepUp = getCategory("phono_step_up_transformer");
  assert.equal(phonoEq?.parentId, "analog");
  assert.equal(stepUp?.parentId, "analog");
  assert.equal(stepUp?.order, (phonoEq?.order ?? 0) + 1);
});
