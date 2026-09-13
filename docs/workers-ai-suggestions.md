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

## Budget policy

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
