---
name: hifiscout-js-to-ts-migration
description: Project-specific guidance for completing HiFiScout's JavaScript-to-TypeScript migration safely and consistently.
---

# HiFiScout JS → TS Migration

Use this skill for Phase 2.5 TypeScript migration work.

- Follow `AGENTS.md` first.
- Preserve strict TypeScript; do not enable `allowJs` or disable strictness to bypass errors.
- Prefer `unknown` plus narrowing, shared domain types, typed boundaries, and explicit null handling over broad `any` or blanket assertions.
- Fix high-impact shared types before patching many individual call sites.
- Treat D1 rows, fetch/JSON/parser data, environment values, DOM values, and third-party payloads as typed boundaries.
- Keep tests, fixtures, mocks, E2E, scripts, frontend, infrastructure, and application source in TypeScript.
- Run `npm run typecheck` repeatedly while reducing diagnostics.
- Before committing migration changes, satisfy the format, lint, unit-test, typecheck, and no-JavaScript-source checks required by `AGENTS.md`.
- Phase 2.5 is complete only when `npm run typecheck` has zero diagnostics and `npm run check:no-js-source` passes.
- Integrate typecheck and no-JavaScript-source enforcement into normal CI before removing temporary Phase 2.5 workflows.
- Remove temporary migration-only snapshot/debug/patch artifacts before declaring completion.
- Keep PR #126 Draft until required validation is green; when completing the migration, verify the post-merge `main` pipeline is green as well.
- Never trust a stale handoff SHA or diagnostic count; verify the current branch state first.

Report branch/SHA, typecheck result, no-JS result, relevant validation results, PR/check state, cleanup status, and post-merge main status when applicable.
