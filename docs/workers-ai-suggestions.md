# Workers AI catalog suggestions

Issue [#350](https://github.com/apaapapapapa/HiFiScout/issues/350) adds operator-only
`catalog_model_lead` suggestions after deterministic classification and official verification.
The initial contract accepts only existing catalog IDs and exact substrings of supplied seller
evidence. A validated suggestion is advisory: it cannot verify a catalog product, register an
alias, change a listing, or merge identities. Review and the existing authoritative save remain
separate actions. Other suggestion kinds require their own contract and evaluation.

## Contract and evaluation

`src/ai-suggestions/contract.ts` owns request admission, JSON validation, evidence checks,
variant/accessory/category/collision vetoes, and the input fingerprint. Seller text is untrusted
data and the model receives no tools or URLs. Input snapshots are rebuilt from allowlisted fields;
raw seller pages, credentials and unrelated context are never included.

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
evaluation, and an unblocked daily account-budget grant. Deployment defaults are disabled with no
evaluation approval. An operator grant must represent capacity reserved after accounting for all
other account AI consumers; analytics alone can lag and cannot enforce another caller's ceiling.
Grants are immutable for that UTC day and cannot reset reservations. An emergency block is final
for the day. Normal product collection and authoritative classification have no dependency on these
gates or on model availability.

## Free allowance

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
