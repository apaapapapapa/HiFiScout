---
name: hifiscout-ui-changes
description: "HiFiScoutの検索・フィルター・商品詳細・比較・管理画面のUI/UXを改善しブラウザーで検証する。Use for public/admin interaction changes and UI regressions; SQL cost or product identity defects require their domain skills."
---

# HiFiScout UI changes

## Reproduce the user task

Identify the route, device/viewport, current filter state and expected result. Read
[DESIGN.md](../../../DESIGN.md) for public UI and
[listing admin](../../../docs/listing-admin.md) for admin behavior. Inspect the current React
components/contracts before introducing a new pattern. Apply requested improvements within the
existing product language and shared controls; avoid unrelated framework/design replacement.

For live-site investigation, verify the target environment and deployed version. Prefer a local
fixture for deterministic states; use available authorized browser capabilities when actual
interaction is needed. Do not introduce or weaken production authentication for browser testing.

## Protect the interaction contract

- For public search, keep URL state, structured manufacturer/category filters, draft/applied
  conditions, page reset, Back/Forward and direct product links consistent. Preserve unrelated
  filters when following category/manufacturer shortcuts. Unknown category IDs must not become
  guessed links. Sticky conditions must reflect applied state and not obscure results or focus.
- Product cards represent entities; individual offers retain their own shop, price, condition,
  stock and URL. Keep filter/count/sort semantics on the same matching offer. If the issue is
  wrong identity or SQL predicates, use the catalog/load skill instead of hiding the bad result.
- For admin operations, retain preview/apply distinctions, optimistic revisions, durable operation
  IDs, partial failures and saved job progress. Make resume/retry behavior and actual completion
  visible without adding constant polling or full-table counts on navigation. Prefer existing
  bounded endpoints and shared contracts over duplicated API definitions.
- Preserve keyboard labels/focus, mobile and tablet layout, loading/empty/error/retry states,
  dialog dismissal and session-expiry recovery. Keep public `/api/admin/*` unavailable and admin
  changes behind the Access-protected Worker/Service Binding boundary. Validate images and links
  under the actual CSP/security headers when those behaviors change.

## Choose the smallest meaningful browser check

Read [testing strategy](../../../docs/testing-strategy.md); run relevant cases in these suites:

| Changed boundary | Existing command |
| --- | --- |
| Public React interaction/responsive state | `vp exec playwright test --config e2e/playwright.components.config.ts` |
| Admin frontend with real Worker entry and mocked Access/JWKS/RPC | `vp run test:e2e:admin` |
| Deployed public wiring | `vp run test:e2e` with an explicitly verified `E2E_BASE_URL` |

Use local admin fixtures for write operations. They exercise JWT verification with test keys and
mock only the external Access/RPC boundaries; do not ask for production login credentials or add
a test-token bypass. The admin suite deliberately ignores `E2E_BASE_URL`.

Use representative desktop/mobile/tablet views for layout changes and inspect screenshots when
geometry matters. Assert observable interaction and network/URL outcomes rather than incidental
DOM structure. Live E2E should not depend on a specific changing product, price or exact inventory
count. Apply `AGENTS.md` source validation once, then follow delivery and report the user-visible
result and material limitations.
