---
name: hifiscout-ui-changes
description: "HiFiScoutの公開検索・フィルター・商品詳細・比較・管理画面の操作、表示、ブラウザー不具合の修正に使う。"
---

# HiFiScout UI changes

Use [DESIGN.md](../../../DESIGN.md) for public UI and the relevant [listing admin](../../../docs/listing-admin.md)
section for admin tasks. Trace the affected route, state and current React components/contracts.
Use local fixtures for deterministic states; live investigation needs the target environment/version.

## Preserve the affected interaction

- Public filters: URL and draft/applied state, page reset, Back/Forward and direct links stay consistent.
  Shortcuts preserve unrelated filters; unknown category IDs must not become guessed links. Sticky
  conditions reflect applied state without hiding results/focus.
- Product cards represent entities; offers retain their own shop, price, condition, stock and URL.
  Count/filter/sort semantics refer to the same matching offer. Trace wrong identity or predicates
  to catalog/query owners instead of masking the data in rendering.
- Admin: preserve preview/apply, optimistic revisions, durable operation IDs, partial failures and
  saved progress. Reuse bounded endpoints/shared contracts; navigation must not add constant polling
  or full-table counts. Keep completion, retry/resume and session-expiry recovery understandable.
- Retain keyboard/focus behavior, responsive layout and loading/empty/error states. Images/links need
  the real CSP/security headers when those behaviors change. Local fixtures must not weaken production
  Access or add test-token bypasses.

## Verify the changed boundary

Choose relevant cases from [testing strategy](../../../docs/testing-strategy.md):

| Boundary | Existing suite |
| --- | --- |
| Public React interaction/layout | `vp exec playwright test --config e2e/playwright.components.config.ts` |
| Admin UI, real Worker entry, mocked Access/JWKS/RPC | `vp run test:e2e:admin` (local writes; ignores `E2E_BASE_URL`) |
| Actual deployed public wiring | `vp run test:e2e` with verified `E2E_BASE_URL` |

Inspect representative viewport screenshots when geometry changes and interaction/network/URL results
when behavior changes. Assert user outcomes rather than incidental DOM structure; live tests cannot
depend on a fixed product/price/count. Use existing CI browser evidence, or [harness ui](../../../.github/harness/README.md#isolated-ui-evidence)
when a fresh full gallery/admin evidence bundle is needed. It is not required for every visual edit.
Complete the requested visible behavior and report validation/limitations through the repository's
delivery flow; a screenshot alone does not establish successful interaction.
