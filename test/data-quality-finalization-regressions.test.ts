import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";

import { manufacturerIdForFilter } from "../src/catalog/manufacturers.js";

const remediationService = readFileSync(
  new URL("../src/db/data-quality-remediation-service.ts", import.meta.url),
  "utf8",
);
const replayDrain = readFileSync(
  new URL("../scripts/resolver-replay-drain.ts", import.meta.url),
  "utf8",
);

test("generic DQ replay keeps public manufacturer_id separate from verified canonical id", () => {
  assert.notEqual(manufacturerIdForFilter("Mystery Audio"), "");
  assert.match(
    remediationService,
    /const manufacturerFilterId = manufacturerIdForFilter\([\s\S]*?manufacturer\.displayName \|\| row\.manufacturer \|\| row\.raw_manufacturer/u,
  );
  assert.equal(
    [
      ...remediationService.matchAll(
        /manufacturerFilterId,\s*manufacturer\.canonicalManufacturerId,/gu,
      ),
    ].length,
    2,
    "both UPDATE and change-detection binds must use the public filter id before canonical id",
  );
});

test("administrative resolver drain uses bulk resolver replay and batched generic claims", () => {
  assert.match(replayDrain, /reprocessStaleManufacturerListings/u);
  assert.match(replayDrain, /reprocessStaleModelListings/u);
  assert.match(replayDrain, /MODEL_RESOLVER_SCOPED_SHOPS/u);
  assert.match(replayDrain, /current\.stale\.model === current\.stale\.total/u);
  assert.match(replayDrain, /limit:\s*250/u);
  assert.equal(
    [...replayDrain.matchAll(/claimLimit:\s*10/gu)].length,
    2,
    "existing-queue and top-up drains should both process bounded batches",
  );
});
