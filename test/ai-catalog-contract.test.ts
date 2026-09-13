import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import type { AiCatalogSnapshot } from "../src/api/admin-ai-contracts.js";
import {
  aiCandidateVeto,
  aiSnapshotFingerprint,
  buildAiRequest,
  parseAiSnapshot,
  validateAiSuggestion,
} from "../src/ai-suggestions/contract.js";
import { evaluateAiResponses } from "../src/ai-suggestions/evaluation.js";
import {
  aiBudgetDay,
  aiReservationMilliNeurons,
  aiUsageMilliNeurons,
} from "../src/ai-suggestions/policy.js";
import { aiCatalogEvaluationCases } from "./fixtures/ai-catalog-evaluation.js";

const snapshot = (): AiCatalogSnapshot => structuredClone(aiCatalogEvaluationCases[0].snapshot);
const suggestion = (catalogProductId = 101, evidence = ["D-1000 MK2"]) => ({
  decision: "suggestion",
  catalogProductId,
  evidence,
});
const abstain = { decision: "no_suggestion", catalogProductId: null, evidence: [] };

test("AI contract admits only supplied IDs and verbatim seller evidence", () => {
  const input = snapshot();
  assert.deepEqual(validateAiSuggestion(input, JSON.stringify(suggestion())), suggestion());
  assert.deepEqual(validateAiSuggestion(input, abstain), abstain);
  for (const response of [
    suggestion(999),
    suggestion(101, ["official manufacturer confirmed"]),
    suggestion(101, [""]),
    { ...suggestion(), confidence: 1 },
    { ...abstain, catalogProductId: 101 },
    "not json",
    "x".repeat(4097),
    { ...suggestion(), evidence: Array(4).fill("D-1000 MK2") },
  ])
    assert.throws(() => validateAiSuggestion(input, response));
});

test("revision, accessory, bundle and normalization vetoes survive an AI suggestion", () => {
  for (const input of [
    { ...snapshot(), target: { ...snapshot().target, model: "D-1000", rawModels: ["D-1000"] } },
    { ...snapshot(), target: { ...snapshot().target, title: "D-1000 MK2 専用リモコン" } },
    { ...snapshot(), target: { ...snapshot().target, rawModels: ["D1000+DA1000"] } },
    { ...snapshot(), target: { ...snapshot().target, rawModels: ["D-1000 MK2 特別仕様"] } },
    { ...snapshot(), target: { ...snapshot().target, rejectedBy: ["normalization_collision"] } },
    {
      ...snapshot(),
      candidates: [...snapshot().candidates, { ...snapshot().candidates[0], id: 102 }],
    },
  ]) {
    assert.ok(aiCandidateVeto(input, 101));
    assert.throws(() => validateAiSuggestion(input, suggestion()));
    assert.deepEqual(validateAiSuggestion(input, abstain), abstain);
  }
});

test("snapshot allowlist rejects unknown taxonomy and manufacturers without sending extra data", () => {
  const input = snapshot();
  assert.deepEqual(
    parseAiSnapshot({
      ...input,
      html: "secret",
      target: { ...input.target, sourceUrl: "https://example.test" },
    }),
    input,
  );
  for (const bad of [
    { ...input, kind: "category_lead" },
    { ...input, target: { ...input.target, manufacturerId: "unknown-brand" } },
    { ...input, target: { ...input.target, categoryIds: ["other"] } },
    { ...input, candidates: [{ ...input.candidates[0], manufacturerId: "kef" }] },
    { ...input, candidates: Array(6).fill(input.candidates[0]) },
  ])
    assert.equal(parseAiSnapshot(bad), null);
});

test("bounded request isolates seller instructions and fingerprints evidence and catalog revisions", async () => {
  const input = snapshot();
  const request = buildAiRequest(input);
  assert.equal(request.max_tokens, 300);
  assert.equal(request.stream, false);
  assert.equal("tools" in request, false);
  assert.ok(!JSON.stringify(request).includes("2026-09-13"));
  assert.throws(
    () =>
      buildAiRequest({
        ...input,
        target: { ...input.target, title: "語".repeat(240), rawModels: ["型".repeat(160)] },
      }),
    /input_too_large/,
  );
  const first = await aiSnapshotFingerprint(input);
  assert.equal(first, await aiSnapshotFingerprint(snapshot()));
  for (const changed of [
    { ...input, target: { ...input.target, title: "D-1000 MK2 専用リモコン" } },
    { ...input, target: { ...input.target, revision: "changed" } },
    { ...input, candidates: [{ ...input.candidates[0], revision: "changed" }] },
  ])
    assert.notEqual(first, await aiSnapshotFingerprint(changed));
});

test("evaluation distinguishes unsafe suggestions, rejected responses and useful coverage", () => {
  const cases = aiCatalogEvaluationCases;
  const valid = cases.map((item) =>
    item.expectedCatalogProductId === null
      ? abstain
      : {
          decision: "suggestion",
          catalogProductId: item.expectedCatalogProductId,
          evidence: [item.snapshot.target.model],
        },
  );
  assert.equal(evaluateAiResponses(cases, valid).passed, true);
  const empty = evaluateAiResponses(
    cases,
    cases.map(() => abstain),
  );
  assert.equal(empty.passed, false);
  assert.ok(empty.missedSuggestions > 0);
  assert.equal(
    evaluateAiResponses(
      cases,
      cases.map(() => "bad json"),
    ).invalidResponses,
    cases.length,
  );
  assert.throws(() => evaluateAiResponses(cases, []));
});

test("budget uses UTC windows and pessimistic per-attempt reservations", () => {
  assert.equal(aiBudgetDay(new Date("2026-09-13T08:59:59+09:00")), "2026-09-12");
  assert.equal(aiBudgetDay(new Date("2026-09-13T09:00:00+09:00")), "2026-09-13");
  assert.equal(aiReservationMilliNeurons(), 18393);
  assert.equal(aiUsageMilliNeurons(2000, 300), 18393);
  assert.equal(aiUsageMilliNeurons(-1, 100), null);
  assert.equal(aiUsageMilliNeurons(1, Number.NaN), null);
  assert.ok(aiReservationMilliNeurons() * 25 * 2 < 1000 * 1000);
});
