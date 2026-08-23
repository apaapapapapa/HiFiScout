import { test } from "vitest";
import assert from "node:assert/strict";

import { manufacturerFilterIds } from "../src/catalog/manufacturers.js";

test("manufacturer filters include canonical and pre-normalization alias ids", () => {
  // Exercise both a short seller alias and a punctuation-heavy alias from the legacy resolver.
  assert.deepEqual(
    new Set(manufacturerFilterIds("MSB Technology")),
    new Set(["msb-technology", "msbtechnology", "msb"]),
  );
  assert.deepEqual(
    new Set(manufacturerFilterIds("Bowers & Wilkins")),
    new Set(["bowers-wilkins", "bowerswilkins", "bowersandwilkins", "bw", "brand-mvkgbk"]),
  );
});
