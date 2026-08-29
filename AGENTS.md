# Repository instructions for AI coding agents

## Required pre-commit checks

For JavaScript/TypeScript changes, always run this before creating a commit:

```sh
vp run verify
```

It applies the formatter and lint fixes, then runs the read-only gate: `lint`, `format:check`,
`check:no-js-source`, `typecheck`, and the unit tests. Run it once rather than invoking the
underlying commands separately; a green run prints under a kilobyte, and every failure is reported
in full.

Use `vp run check` when the working tree must not be modified, and `vp run fix` to apply
formatting and lint fixes alone.

Do not leave formatter-only failures for CI or a human to fix. Apply `vp run format`, review the resulting diff, and include the formatting changes in the same commit whenever possible.

GitHub Actions also auto-formats pull requests as a defense-in-depth measure. Do not rely on CI autoformatting instead of running the formatter before committing.

## TypeScript-only source policy

- New first-party application, test, script, E2E, infrastructure, frontend, and tooling source must be TypeScript (or a non-JavaScript declarative format).
- Do not add tracked `.js`, `.mjs`, `.cjs`, or `.jsx` first-party source/config files. Generated JavaScript belongs in ignored build output only.
- Vendored third-party agent skills are not first-party source. Archify is pinned by `skills-lock.json` and lives under `.agents/skills/archify/`; do not edit its vendored JavaScript as application source.
- `vp run verify` covers `typecheck`, `format:check`, `lint`, and `check:no-js-source`; run it before publishing changes.

## Keeping agent output small

An agent's context window is a real budget, and command output is charged against it on every
subsequent turn. Repository tooling is configured to stay quiet when it succeeds and verbose when
it fails.

- Prefer `vp run verify` over separate check commands.
- Unit tests use the dot reporter. Use `vp run test:unit:verbose` only when you need test names.
- Wrap new noisy-but-successful tooling in `tsx scripts/run-quiet.ts <command> [args...]`, which suppresses output on success and replays it in full on failure.
- Generated output (`dist/`, `.generated/`, `public/*.js`, `admin-public/*.js`, `docs/public/`, `package-lock.json`) is never a source of truth. Read the source instead.
- Claude Code users: `CLAUDE.md` provides the repository map and per-task entry points.

## Documentation and workflow lifecycle

Keep `main` focused on current sources of truth rather than implementation history.

- Update a canonical document instead of adding another dated status/progress file when possible.
- Delete completed migration plans and production snapshots once their durable invariants are encoded in current code, tests, or maintained docs. Git history is the archive.
- Remove one-off GitHub Actions workflows and helper scripts after the permanent runtime/operational path replaces them.
- Do not duplicate dynamic shop inventories, schedules, schema details, or environment values in prose when a canonical source file already exists.
- Before deleting operational automation, verify that no recurring production responsibility still depends on it.
