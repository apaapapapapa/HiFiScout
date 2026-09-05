import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { partitionTests } from "../scripts/ci/test-shards.js";

test("weighted shards balance uneven files and include each discovered test exactly once", () => {
  const tests = [18, 7, 5, 4, 3, 2, 1, 1, 1].map((weight, index) => ({
    id: `file-${index}`,
    weight,
  }));
  const shards = partitionTests(tests, 2);
  assert.deepEqual(shards.flat().sort(), tests.map((test) => test.id).sort());
  const weights = new Map(tests.map((test) => [test.id, test.weight]));
  const loads = shards.map((files) => files.reduce((total, id) => total + weights.get(id)!, 0));
  assert.ok(Math.abs(loads[0] - loads[1]) <= 1);
  assert.deepEqual(
    partitionTests([...tests].reverse(), 2),
    shards,
    "discovery order must not affect membership",
  );
  assert.equal(
    partitionTests([...tests, { id: "new-file", weight: 250 }], 2)
      .flat()
      .filter((id) => id === "new-file").length,
    1,
  );
});
