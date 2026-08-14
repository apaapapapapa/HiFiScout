# Module Dependencies

HiFiScout uses dependency-cruiser to analyze ES module imports under `src/`.

<a href="../generated/dependencies.html" target="_self">Open the generated interactive dependency report</a>

## CI architecture check

The dependency configuration currently enforces one high-confidence invariant: production source dependencies must remain acyclic. This deliberately starts with a narrow rule rather than encoding assumptions about layer boundaries that are still evolving with the data-platform refactor.

As repository boundaries stabilize, additional rules can be added to `.dependency-cruiser.json` for constraints such as preventing domain code from bypassing repository abstractions.

dependency-cruiser parses the TypeScript sources with its own pinned `typescript@5.9.3`, supplied through the `npx -p` invocation in the `docs:architecture*` scripts. dependency-cruiser 18.1.0 does not yet accept the project's `typescript@7` compiler, and without a compatible parser it silently cruises zero modules instead of failing.

## Generation

```sh
npm run docs:architecture:check
npm run docs:architecture
```

The first command fails on configured architecture violations. The second produces the self-contained HTML report embedded in the VitePress output.
