import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import recording from "../evaluations/workers-ai/2026-09-13-holdout-v2-qwen3-prompt3.json";
import report from "../evaluations/workers-ai/2026-09-13-holdout-v2-evaluation.json";
import labelReview from "../evaluations/workers-ai/2026-09-13-holdout-label-review.json";
import priorRun from "../evaluations/workers-ai/2026-09-13-qwen3-prompt3.json";
import { aiResponseDigest, evaluateAiHoldout } from "../scripts/harness/ai.js";
import { aiReservationMilliNeurons } from "../src/ai-suggestions/policy.js";
import { validateAiSelection } from "../src/ai-suggestions/contract.js";
import { aiCatalogHoldoutCases } from "./fixtures/ai-catalog-holdout.js";

test("live holdout retains the failed model gate and binds native responses, usage and frozen labels", async () => {
  assert.equal(aiResponseDigest(labelReview), recording.labelReviewDigest);
  assert.equal(aiResponseDigest(recording), report.recordingDigest);
  assert.equal(recording.measurement.sourceArchive.commitSha, recording.sourceSha);
  assert.equal(recording.groundTruthReview.reviewedAt, labelReview.reviewedAt);
  assert.ok(labelReview.reviewedAt < recording.measurement.requestPlanCreatedAt);
  assert.ok(recording.measurement.requestPlanCreatedAt < recording.measurement.startedAt);
  const observed = await evaluateAiHoldout(recording);
  assert.deepEqual(observed, report.offlineReplay);
  assert.equal(observed.status, "fail");
  assert.equal(observed.invalidAttempts, 5);
  assert.equal(observed.pipeline?.falseSuggestions, 0);
  assert.equal(observed.pipeline?.suggestionRecall, 0.8);
  assert.equal(observed.activationApproved, false);
  assert.equal(observed.responseProvenanceVerified, false);

  assert.equal(recording.captures.length, recording.measurement.liveModelCalls);
  assert.equal(new Set(recording.captures.map((item) => item.id)).size, recording.captures.length);
  assert.equal(recording.captures[0].startedAt, recording.measurement.startedAt);
  assert.equal(recording.captures.at(-1)?.finishedAt, recording.measurement.finishedAt);
  for (const entry of recording.cases) {
    const captures = recording.captures.filter((capture) => capture.id === entry.id);
    assert.equal(captures.length, entry.request ? 1 : 0);
    if (!entry.request) continue;
    const capture = captures[0];
    const attempt = entry.attempts[0];
    assert.equal(capture.requestDigest, aiResponseDigest(entry.request));
    assert.equal(capture.success, true);
    assert.equal(capture.status, 200);
    assert.equal(capture.ordinal, 1);
    assert.deepEqual(capture.errors, []);
    assert.equal(attempt.requestId, capture.result.id);
    assert.equal(attempt.model, capture.result.model);
    assert.equal(attempt.requestedAt, capture.startedAt);
    assert.equal(attempt.latencyMs, capture.latencyMs);
    assert.equal(Date.parse(capture.finishedAt) - Date.parse(capture.startedAt), capture.latencyMs);
    assert.deepEqual(attempt.response, capture.result.response);
    assert.deepEqual(
      JSON.parse(capture.result.choices[0].message.content),
      capture.result.response,
    );
    assert.deepEqual(attempt.usage, {
      inputTokens: capture.result.usage.prompt_tokens,
      outputTokens: capture.result.usage.completion_tokens,
      neurons: capture.result.usage.neurons,
    });
    assert.equal(
      capture.result.usage.total_tokens,
      attempt.usage.inputTokens + attempt.usage.outputTokens,
    );
    assert.ok(attempt.usage.neurons * 1000 <= capture.reservedMilliNeurons);
    if (entry.review) assert.ok(entry.review.reviewedAt >= capture.finishedAt);
    if (attempt.response.catalogProductId === null && attempt.response.evidenceIndex !== null) {
      const item = aiCatalogHoldoutCases.find((item) => item.id === entry.id)!;
      assert.throws(() => validateAiSelection(item.snapshot, attempt.response), /invalid_schema/u);
      assert.equal(entry.review?.decision, "rejected");
    }
  }
  const budget = recording.measurement.budget;
  assert.equal(
    budget.priorReservationsMilliNeurons,
    priorRun.budget.cumulativeReservedMilliNeurons,
  );
  assert.equal(
    budget.reservedThisRunMilliNeurons,
    recording.captures.length * aiReservationMilliNeurons(),
  );
  assert.equal(
    budget.cumulativeReservedMilliNeurons,
    budget.priorReservationsMilliNeurons + budget.reservedThisRunMilliNeurons,
  );
  assert.ok(budget.cumulativeReservedMilliNeurons <= budget.allowanceMilliNeurons);
});
