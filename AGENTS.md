# Repository instructions for AI coding agents

## Required pre-commit checks

For JavaScript/TypeScript changes, always run this before creating a commit:

```sh
npm run verify
```

It applies the formatter and lint fixes, then runs the read-only gate: `lint`, `format:check`,
`check:no-js-source`, `typecheck`, and the unit tests. Run it once rather than invoking the
underlying commands separately; a green run prints under a kilobyte, and every failure is reported
in full.

Use `npm run check` when the working tree must not be modified, and `npm run fix` to apply
formatting and lint fixes alone.

Do not leave formatter-only failures for CI or a human to fix. Apply `npm run format`, review the resulting diff, and include the formatting changes in the same commit whenever possible.

GitHub Actions also auto-formats pull requests as a defense-in-depth measure. Do not rely on CI autoformatting instead of running the formatter before committing.

## TypeScript-only source policy

- New first-party application, test, script, E2E, infrastructure, frontend, and tooling source must be TypeScript (or a non-JavaScript declarative format).
- Do not add tracked `.js`, `.mjs`, `.cjs`, or `.jsx` first-party source/config files. Generated JavaScript belongs in ignored build output only.
- `npm run verify` covers `typecheck`, `format:check`, `lint`, and `check:no-js-source`; run it before publishing changes.

## Keeping agent output small

An agent's context window is a real budget, and command output is charged against it on every
subsequent turn. Repository tooling is configured to stay quiet when it succeeds and verbose when
it fails.

- Prefer `npm run verify` over separate check commands.
- Unit tests use the dot reporter. Use `npm run test:unit:verbose` only when you need test names.
- Wrap new noisy-but-successful tooling in `tsx scripts/run-quiet.ts <command> [args...]`, which
  suppresses output on success and replays it in full on failure.
- Generated output (`dist/`, `.generated/`, `public/*.js`, `docs/public/`, `package-lock.json`) is
  never a source of truth. Read the source instead.
- Claude Code users: `CLAUDE.md` adds a repository map and per-task entry points so common changes
  do not require exploratory searching.
