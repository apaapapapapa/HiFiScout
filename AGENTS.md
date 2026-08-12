# Repository instructions for AI coding agents

## Required pre-commit checks

For JavaScript/TypeScript changes, always run these commands before creating a commit:

1. `npm run format`
2. `npm run format:check`
3. `npm run lint`
4. `npm test`

Do not leave formatter-only failures for CI or a human to fix. Apply `npm run format`, review the resulting diff, and include the formatting changes in the same commit whenever possible.

GitHub Actions also auto-formats pull requests as a defense-in-depth measure. Do not rely on CI autoformatting instead of running the formatter before committing.

## TypeScript-only source policy

- New first-party application, test, script, E2E, infrastructure, frontend, and tooling source must be TypeScript (or a non-JavaScript declarative format).
- Do not add tracked `.js`, `.mjs`, `.cjs`, or `.jsx` first-party source/config files. Generated JavaScript belongs in ignored build output only.
- Run `npm run typecheck`, `npm run format:check`, `npm run lint`, and `npm run check:no-js-source` before publishing changes.
