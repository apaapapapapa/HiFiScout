# Repository instructions for AI coding agents

## Required pre-commit checks

For JavaScript/TypeScript changes, always run these commands before creating a commit:

1. `npm run format`
2. `npm run format:check`
3. `npm run lint`
4. `npm test`

Do not leave formatter-only failures for CI or a human to fix. Apply `npm run format`, review the resulting diff, and include the formatting changes in the same commit whenever possible.

GitHub Actions also auto-formats pull requests as a defense-in-depth measure. Do not rely on CI autoformatting instead of running the formatter before committing.
