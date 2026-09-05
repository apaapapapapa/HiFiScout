# TypeScript development

HiFiScout is a TypeScript application. First-party JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`) must not be committed.

## Compiler policy

`tsconfig.json` uses `strict: true` and `noEmit: true`. `allowJs`, `checkJs`, `strict: false`, `noImplicitAny: false`, and `strictNullChecks: false` are intentionally not used. `skipLibCheck` is limited to third-party/runtime declaration compatibility; all first-party source directories remain in the TypeScript program.

Run `vp run verify` before committing source changes. It includes `typecheck`, which regenerates Cloudflare binding/runtime declarations with Wrangler and then runs `tsc --noEmit`. Use `vp run typecheck` separately only when diagnosing type errors.

## Modules and imports

The repository remains ESM (`"type": "module"`). TypeScript uses ESNext modules with bundler-compatible resolution. Vite+ builds the React/browser and Lambda bundles, Wrangler builds Workers, Vitest runs unit tests, and `tsx` executes maintenance/tooling scripts. Existing relative ESM imports use `.js` specifiers in TypeScript source; the toolchain resolves those to TypeScript. Do not introduce `.ts` import suffixes.

## Runtime boundaries

Wrangler owns Cloudflare binding declarations. `vp run types:worker` writes them to `.generated/worker-configuration.d.ts`; generated declarations and JavaScript build artifacts are not hand edited or committed.

External HTML/HTTP/query-string/D1/queue/environment input remains runtime-validated where the application already validates it. TypeScript types do not replace runtime validation. DB row shapes are kept separate from domain/API shapes at repository boundaries when their structures differ.

## Execution and builds

- Unit tests: Vitest through `vp run test:unit`; individual files through `vp test run`.
- Node tooling/maintenance: `vp exec tsx`, including shop scaffolding and D1 integration scripts.
- Public React UI: `frontend/app.tsx` -> `public/app.js` through the `public` mode in `vite.config.ts`.
- Admin React UI: `frontend/admin-console.tsx` -> `admin-public/admin-console.js` through the `admin` mode.
- Public Worker: Wrangler consumes `src/worker.ts`, which wraps the testable `src/index.ts` handlers and exports the DO/RPC classes.
- Admin Worker: Wrangler consumes `src/admin/entry.ts` with `wrangler.admin.jsonc`.
- Lambda relay: `infra/audiounion-lambda/index.ts` -> `dist/audiounion-lambda/index.mjs` through Vite+'s `lambda` mode (Rolldown).
- E2E: Playwright runs `.ts` specs/config directly.

## Type design

Prefer domain-local `type`/`interface` declarations, string-literal unions for status/state, `unknown` for untrusted external values, and discriminated unions for multi-state results. Avoid broad `any`, blanket assertions, `@ts-ignore`, and `@ts-nocheck`. Use `@ts-expect-error` only for a narrow documented upstream limitation.

## JavaScript source guard

`vp run check:no-js-source` examines tracked files and fails if first-party JavaScript source/config is reintroduced. Generated browser/Worker/Lambda JavaScript stays ignored and is produced during build/deploy.

The pinned third-party Archify skill is the explicit integrity-checked exception. Follow `AGENTS.md`
and `skills-lock.json`; its vendored JavaScript is not application source.
