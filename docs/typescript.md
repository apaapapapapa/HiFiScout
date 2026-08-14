# TypeScript development

HiFiScout is a TypeScript application. First-party JavaScript source (`.js`, `.mjs`, `.cjs`, `.jsx`) must not be committed.

## Compiler policy

`tsconfig.json` uses `strict: true` and `noEmit: true`. `allowJs`, `checkJs`, `strict: false`, `noImplicitAny: false`, and `strictNullChecks: false` are intentionally not used. `skipLibCheck` is limited to third-party/runtime declaration compatibility; all first-party source directories remain in the TypeScript program.

Run `npm run typecheck` before opening or updating a PR. The command regenerates Cloudflare binding/runtime declarations with Wrangler and then runs `tsc --noEmit`.

## Modules and imports

The repository remains ESM (`"type": "module"`). TypeScript uses ESNext modules with bundler-compatible resolution because Workers are built by Wrangler/esbuild and Node scripts/tests execute through `tsx`. Existing relative ESM imports use `.js` specifiers in TypeScript source where they describe the emitted/runtime module path; TypeScript and `tsx` resolve those specifiers back to the `.ts` source. Do not introduce `.ts` import suffixes.

## Runtime boundaries

Wrangler owns Cloudflare binding declarations. `npm run types:worker` writes them to `.generated/worker-configuration.d.ts`; generated declarations and JavaScript build artifacts are not hand edited or committed.

External HTML/HTTP/query-string/D1/queue/environment input remains runtime-validated where the application already validates it. TypeScript types do not replace runtime validation. DB row shapes are kept separate from domain/API shapes at repository boundaries when their structures differ.

## Execution and builds

- Node scripts/tests: `tsx` (`npm test`, `npm run create-shop`, search verification scripts).
- Browser source: `frontend/*.ts` -> generated `public/*.js` via esbuild. Static HTML/CSS remain unchanged.
- Cloudflare Worker: Wrangler consumes `src/index.ts` directly; no second Worker transpilation layer is added.
- Lambda relay: `infra/audiounion-lambda/index.ts` -> generated ESM artifact under `dist/audiounion-lambda/` via esbuild.
- E2E: Playwright runs `.ts` specs/config directly.

## Type design

Prefer domain-local `type`/`interface` declarations, string-literal unions for status/state, `unknown` for untrusted external values, and discriminated unions for multi-state results. Avoid broad `any`, blanket assertions, `@ts-ignore`, and `@ts-nocheck`. Use `@ts-expect-error` only for a narrow documented upstream limitation.

## JavaScript source guard

`npm run check:no-js-source` examines tracked files and fails if first-party JavaScript source/config is reintroduced. Generated browser/Worker/Lambda JavaScript stays ignored and is produced during build/deploy.
