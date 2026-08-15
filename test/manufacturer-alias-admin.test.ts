import assert from "node:assert/strict";
import test from "node:test";
import { parseManufacturerAliasAdminRequest } from "../src/http/manufacturer-alias-admin.js";

test("manufacturer alias admin input is bounded and explicit", () => {
  assert.deepEqual(
    parseManufacturerAliasAdminRequest({
      manufacturerId: "TAD",
      canonicalName: "TAD",
      alias: "Technical Audio Devices",
      verificationStatus: "verified",
      source: "manual_verified",
      provenance: { ticket: "DQ-3" },
      ruleVersion: 2,
      afterId: 40,
      limit: 100,
    }),
    {
      input: {
        manufacturerId: "tad",
        canonicalName: "TAD",
        alias: "Technical Audio Devices",
        verificationStatus: "verified",
        source: "manual_verified",
        provenance: { ticket: "DQ-3" },
        ruleVersion: 2,
      },
      replay: { afterId: 40, limit: 100 },
    },
  );
});

test("manufacturer alias admin rejects ambiguous or oversized input", () => {
  assert.equal(
    parseManufacturerAliasAdminRequest({
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "TAD",
      verificationStatus: "automatic",
      source: "manual_verified",
    }),
    null,
  );
  assert.equal(
    parseManufacturerAliasAdminRequest({
      manufacturerId: "tad",
      canonicalName: "TAD",
      alias: "TAD",
      verificationStatus: "verified",
      source: "manual_verified",
      provenance: { evidence: "x".repeat(5000) },
    }),
    null,
  );
});
