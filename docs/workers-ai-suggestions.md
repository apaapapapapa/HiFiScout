# Workers AI catalog suggestions

Issue [#350](https://github.com/apaapapapapa/HiFiScout/issues/350) adds operator-only
`catalog_model_lead` suggestions after deterministic classification and official verification.
The inference contract accepts only supplied catalog IDs and indexes into a supplied seller-evidence
list. The server resolves each index to its exact seller string and validates the existing advisory
contract. A validated suggestion cannot verify a catalog product, register an
alias, change a listing, or merge identities. Review and the existing authoritative save remain
separate actions. Other suggestion kinds require their own contract and evaluation.

## Contract and evaluation

`src/ai-suggestions/contract.ts` owns request admission, JSON validation, evidence checks,
variant/accessory/category/collision vetoes, and the input fingerprint. Seller text is untrusted
data and the model receives no tools or URLs. Input snapshots are rebuilt from allowlisted fields;
raw seller pages, credentials and unrelated context are never included.

The complete snapshot is checked before selecting eligible catalog options for the request. This
preserves collision detection while preventing already-vetoed options from reaching the model.
When no option survives, the job records a deterministic abstention without a Queue send, AI call
or budget reservation. The detail identifies that AI was not run. A real-workerd fixture measures
16 rows read, 7 written, and 8 statements for this preparation; repeating it writes zero rows.
The original full alternative set remains in the fingerprint and reviewer snapshot.

`test/fixtures/ai-catalog-evaluation.ts` contains semantic expectations adapted from the existing
decision-quality corpus. The fixtures and stubbed responses do **not** demonstrate live accuracy.
Normal CI uses fixed responses only. A live report must identify the deployed policy, corpus and
prompt versions, case outcomes, provider token usage, latency, retries and all invalid responses.
The initial gate requires zero false suggestions, zero invalid responses, at least 80% recall on
positive cases, and both positive and abstention cases. This small corpus is a canary gate, not a
statistical guarantee of population accuracy. A larger reviewed production sample and reviewer
outcomes are needed before expanding the feature.

## Queue and storage

The Worker has a dedicated `AI_CATALOG_QUEUE` and DLQ, with one message and one consumer at a
time. `ai_catalog_jobs` stores the immutable evidence snapshot before enqueueing. Its SHA-256 key
includes the supplied alternatives and all inference policy settings. Point lookups recheck the
current candidate and catalog before inference, after inference and before recording a review.
Last-seen timestamps alone do not invalidate an otherwise identical snapshot.

Only pending candidates with a verified manufacturer, active observations and a completed
`not_found`, `ambiguous` or `unsupported` official-verification attempt qualify. Discovery reuses
the existing indexed exact/alias and bounded fuzzy lookup. More than five alternatives, excessive
raw-model variants or an oversized request defer to ordinary review instead of dropping evidence.
The initial canary is operator-selected; it does not scan every listing on a crawl.

An atomic D1 batch inserts an attempt, reserves its pessimistic cost and claims the job. The daily
25-job limit includes retries of jobs created on previous days. A duplicate delivery cannot obtain
another lease. At most two attempts are admitted per evidence fingerprint. A 60-second request
timeout, unknown/over-limit usage or provider error cannot refund capacity. Unknown usage blocks
the day's allowance; expired leases become deferred instead of silently invoking again. No new
inference is admitted in the final 15 minutes of a UTC budget window.

Hourly maintenance uses bounded status/age indexes to recover unsent jobs and expire old data.
Retention still runs while inference is disabled. Job snapshots, validated suggestions and attempt
metadata expire after 180 days in bounded batches. Queue logs contain identifiers, outcomes and
D1 counters, never prompts or response payloads. The initial implementation calls the AI binding
directly; it does not require AI Gateway or store prompt/response payloads in R2.

Inference requires all three gates: `AI_CATALOG_ENABLED=true`, an
`AI_CATALOG_EVALUATION_POLICY` equal to the exact serialized policy that passed a recorded live
evaluation, and an unblocked daily account-budget grant. The deployed prompt-3/schema-2 policy is
approved only for the operator-selected canary described below. A policy change invalidates that
exact approval key. An operator grant must represent capacity reserved after accounting for all
other account AI consumers; analytics alone can lag and cannot enforce another caller's ceiling.
Grants are immutable for that UTC day and cannot reset reservations. An emergency block is final
for the day. Normal product collection and authoritative classification have no dependency on these
gates or on model availability.

## Operator review

The Access-protected console's **AIの型番候補** view is reached from a candidate's **AI候補を確認**
link or directly with `#ai`. Operators prepare one existing candidate at a time. A disabled or
quota-deferred job needs **当日の予算で再開** after the gates are satisfied; preparing the same
fingerprint never starts another inference. The status list uses a 20-row indexed keyset page;
only opening one detail pays for current-evidence revalidation.

The detail shows every supplied alternative, exact seller-evidence spans, token usage, reserved
and measured Neurons, latency and attempt outcomes. **役に立った**, **誤り** and **証拠不足** record
advisory quality only. A fresh, useful suggestion offers a link to the existing candidate Verify
form. It does not fill that form with an AI answer or an invented source. The operator must check
the official model and sale object and provide the verification source themselves.

The handoff carries the suggestion ID. Existing Verify rechecks the evidence fingerprint, reviewed
outcome, supplied catalog ID, model and category before saving. Its final candidate/alias batch
checks the current target and selected catalog again, plus a manufacturer revision captured before
reading the full evidence snapshot. Relevant candidate, manufacturer, catalog, model-alias and
category mutations advance that revision, including changes to secondary categories or alternative
products. A mismatch rolls back the entire batch. The clock is registered only on a manual AI
handoff and is not part of the AI fingerprint: crawl timestamps and repeated validation do not
rewrite it or cause another inference. Once registered, a relevant semantic mutation costs one
additional D1 row write per affected manufacturer; an unwatched manufacturer adds no row writes.
The real-workerd regression fixture with 500 unrelated revision rows measures first validation at
12 rows read, 2 written (row plus primary-key index), and 8 statements; repeated validation costs
13 rows read, 0 written, and 8 statements. These are fixture measurements, not production totals.
AI handoffs can only select the reviewed existing verified product. They cannot create or revive
catalog products. The existing verification-attempt audit links the suggestion ID, and the ordinary
bounded replay remains responsible for updating listings. A sample title never authorizes a whole
group of accessories or bundles to be treated as the base product.

Budget controls record an operator's recent account-wide capacity check, cap this feature at
1,000 Neurons/day, and provide an irreversible-for-the-day stop. The authenticated Access subject
is the actor; the request body cannot select a reviewer identity or model. Public `/api/admin/*`
still returns 404. These controls cannot approve a live evaluation or enable the deployed feature.

## Model evaluation and activation

The development harness adds a separate 20-case, 10-family holdout in
`test/fixtures/ai-catalog-holdout.ts`. Its product families do not overlap the TAD/LS50 development
canary. Positive spellings are adapted from shop/identity regressions and manufacturer sources;
negative candidates are synthetic mutations. Corpus v2 has a
[source review](https://github.com/apaapapapapa/HiFiScout/blob/main/evaluations/workers-ai/2026-09-13-holdout-label-review.json)
of every label and snapshot, frozen before live responses. It replaces an ambiguous DENON color
alias case and the unsupported SA-10 SE positive, preserving the original cases in Git history.
This is an assistant's source-based review independent of model answers, not a separate human
sign-off. It does not replace or broaden the existing live approval.

The [v2 live holdout result](https://github.com/apaapapapapa/HiFiScout/blob/main/evaluations/workers-ai/2026-09-13-holdout-v2-evaluation.json)
**failed** the zero-invalid-response gate. Six cases abstained before inference; the remaining 14
made one real request each with the unchanged prompt-3/schema-2 policy. Eight of ten positive
cases yielded correct suggestions (80% recall). Five responses combined a null catalog ID with
evidence index 0, which the runtime correctly rejected; two of those were positive cases. There
were no false accepted suggestions. Of the four model-routed negative cases, one returned a
valid abstention and three were invalid. The six deterministic negatives are not model successes.

The [native responses and recording](https://github.com/apaapapapapa/HiFiScout/blob/main/evaluations/workers-ai/2026-09-13-holdout-v2-qwen3-prompt3.json)
retain every provider ID, request, output, timestamp and usage value. The 14 requests used 2,561
input and 248 output tokens, with 19.401296377182007 provider-reported Neurons. REST elapsed times
were 431–884 ms (median 485.5 ms), measured inside the connector; this is not Workers CPU or a
production latency percentile. No response was rewritten or retried to obtain a pass. All 257,502
reserved milli-Neurons remain charged to the manual evaluation ledger (864,471 cumulatively),
independent of the unchanged production operator allowance.

`test/ai-holdout-live-record.test.ts` replays these native observations offline and preserves their
failed result, exact request/usage correspondence and strict rejection. This is a completed
measurement with an unsuccessful model gate. It does not broaden activation. Any prompt/schema
change needs its own reviewed policy, remaining budget and new live evidence; once used to tune
such a change, this corpus is a regression set rather than a fresh holdout.

Use `vp run harness ai-template .generated/ai-recording.json` to create an incomplete recording
template and `vp run harness ai <recording.json> <new-output-dir>` to replay recorded wire responses.
Both commands are offline. The evaluator uses the actual runtime admission and output contracts,
checks the exact policy/corpus/fingerprint/request, and keeps deterministic vetoes separate from
model-only results. Per-attempt latency, nullable provider usage and response-bound reviewer
accept/reject outcomes remain distinct. Reused provider IDs, stale reviews and unsafe responses
are rejected or fail the evaluation. See the
[recording format](https://github.com/apaapapapapa/HiFiScout/blob/main/.github/harness/README.md#workers-ai-holdout-and-review-feedback).

Passing a fixture replay does not authenticate provider or reviewer provenance, prove population
accuracy, grant account budget or authorize activation. The report always marks live evaluation
unknown and activation unapproved; use independently reviewed labels and genuine provider evidence
for a later live evaluation decision. Existing deployed policy, identity vetoes and budget gates
continue to apply.

Use `vp exec tsx scripts/evaluate-ai-catalog.ts responses.json` to evaluate recorded responses for
the fixed corpus. This command is offline and its output explicitly says that response provenance
has not been verified. Keep the real model request/response metadata, corpus/policy versions,
latency and provider usage with the evaluation report; passing hand-written responses is not an
activation approval.

The [2026-09-13 live canary record](https://github.com/apaapapapapa/HiFiScout/blob/main/evaluations/workers-ai/2026-09-13-qwen3-prompt3.json)
contains all requests, native provider responses, token/Neuron usage and admission outcomes. Prompt 1
failed with 11 rejected responses out of 14. Prompt 2 was stopped after selecting a different revision.
Both failed records are retained next to the final record; neither authorizes activation.

Prompt 3/schema 2 uses scalar catalog/evidence selections and applies the existing vetoes before
inference. In the unchanged 14-case corpus, nine cases abstained deterministically without AI; five
made real Qwen3 requests, producing four correct suggestions and one conservative abstention. There
were zero false accepted suggestions and zero invalid responses in this guarded pipeline, with 80%
positive recall. The five model calls used 1,021 input and 88 output tokens; Cloudflare reported
7.4035 Neurons in total and individual request latency was 415–686 ms. The nine pre-vetoed cases do
not demonstrate the model's independent safety; the initial raw-model failures show why those
guards are necessary. This narrow corpus is not representative production accuracy.

`vp test run test/ai-catalog-contract.test.ts` replays the recorded canary offline and checks exact
request/admission correspondence, policy key, fingerprints, decoded responses and usage bounds. It
does not contact a model or authenticate arbitrary external report provenance. The user confirmed
that this account had no other Workers AI consumers. Grants remain per UTC day: check/reserve the
account's remaining capacity in the admin view before each day's trial; there is no automatic daily
renewal and the 25-job/two-attempt limits are unchanged.

After real-model evaluation passes, review the exact policy and account-wide free-capacity
reservation before setting the deployment gates. Start with the 25-candidate daily cap, inspect
all suggestions manually, and measure false suggestions, accepted fixes, operator time and D1 cost
before expanding coverage. Without those checks, retain the default disabled configuration.

## Free capacity accounting

`src/ai-suggestions/policy.ts` is the only definition of model, request/output limits, attempt
limits, retention and daily allowance. On 2026-09-13 the pinned Qwen3 model costs 4,625 Neurons per
million input tokens and 30,475 per million output tokens. With 2,000 input and 300 output tokens,
an attempt reserves 18,393 milli-Neurons, rounded up. Twenty-five jobs with two attempts reserve
919,650 milli-Neurons. Do not refund a timed-out or usage-unknown attempt.

The entire request is limited to 1,744 UTF-8 bytes plus a reserved 256-token framing allowance.
This is intentionally conservative; actual provider usage must validate admission assumptions.
The model's reasoning tokens count toward the output budget. `/no_think` is a prompting request,
not a billing guarantee. Truncated, malformed or out-of-contract responses must fail validation.
No larger output budget or fallback model is selected automatically.

Workers AI's 10,000 Neurons/day free allocation is shared by the account, resetting at 00:00 UTC
(09:00 JST). A local feature allowance cannot prove that unrelated callers leave free capacity.
An unknown account-budget state must defer inference. Workers, Queues and storage consumption are
separate from AI inference. D1 read/write and statement costs must be measured independently.

References, checked 2026-09-13: [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Qwen3 model](https://developers.cloudflare.com/workers-ai/models/qwen3-30b-a3b-fp8/),
[JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/).
