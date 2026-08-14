# Phase 3 Complete Migration

Phase 3 Shop Platform is fully migrated to the final plugin contract. Compatibility aliases and migration-only adapter fields are intentionally unsupported.

Final invariants:

- shop environment prefixes are derived only from the canonical shop key; `u-audio` uses `U_AUDIO_*` and there is no `UAUDIO_*` fallback;
- `ShopAdapter` contains only universal seller behavior: identity, discovery and seller-fact parsing;
- transport, catalog hints, detail category evidence, inventory recheck, diagnostics, Data Quality thresholds and activity semantics are registered as explicit capabilities;
- discovery behavior uses the typed `discovery.policy` contract rather than legacy pagination booleans;
- every seller parser returns the independent `SellerProduct` contract before centralized catalog normalization;
- catalog normalization no longer accepts crawler adapter-shaped compatibility objects;
- normal shop onboarding uses `scripts/create-shop.ts` and does not require generic crawler, persistence, identity, search, evidence or Data Quality changes.

These boundaries are enforced by TypeScript contracts, shop contract tests, dependency-cruiser rules and the standard CI pipeline.
