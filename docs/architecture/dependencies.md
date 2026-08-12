# Module Dependencies

HiFiScout uses dependency-cruiser to analyze ES module imports under `src/`.

<a href="../generated/dependencies.html" target="_self">Open the generated interactive dependency report</a>

## CI architecture check

The dependency configuration currently enforces one high-confidence invariant: production source dependencies must remain acyclic. This deliberately starts with a narrow rule rather than encoding assumptions about layer boundaries that are still evolving with the data-platform refactor.

As repository boundaries stabilize, additional rules can be added to `.dependency-cruiser.mjs` for constraints such as preventing domain code from bypassing repository abstractions.

## Generation

```sh
npm run docs:architecture:check
npm run docs:architecture
```

The first command fails on configured architecture violations. The second produces the self-contained HTML report embedded in the VitePress output.
