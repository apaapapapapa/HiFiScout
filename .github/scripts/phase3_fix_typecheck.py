from pathlib import Path


def patch(path: str, old: str, new: str, count: int | None = 1) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if count is not None and actual != count:
        raise RuntimeError(f"{path}: expected {count} occurrences, found {actual}: {old[:100]!r}")
    if count is None and actual == 0:
        raise RuntimeError(f"{path}: no occurrences: {old[:100]!r}")
    p.write_text(text.replace(old, new))

# Optional operational defaults still use this validator; discovery policy passes a required number.
patch(
    "src/crawler/shops/registry.ts",
    "function assertNonNegativeInt(key: string, field: string, value: number): void {\n  if (!Number.isInteger(value) || value < 0) {",
    "function assertNonNegativeInt(key: string, field: string, value: number | undefined): void {\n  if (value === undefined) return;\n  if (!Number.isInteger(value) || value < 0) {",
)

patch(
    "src/health.ts",
    "  return isTransportConfigured(env, plugin);\n",
    "  return isTransportConfigured(env, plugin.capabilities.transport?.kind);\n",
)

# Category enrichment tests use registered plugin capabilities, never a concrete adapter as config.
p = Path("test/category-enricher.test.ts")
text = p.read_text()
text = text.replace(
    'import {\n  extractFujiyaDetailCategoryEvidence,\n  fujiyaAvicAdapter,\n} from "../src/crawler/shops/fujiya-avic.js";\n',
    'import { extractFujiyaDetailCategoryEvidence } from "../src/crawler/shops/fujiya-avic.js";\nimport { getShopPlugin } from "../src/crawler/shops/index.js";\n',
)
anchor = 'import { detailFetchOptions, emptyCatalogDb, parsedProduct } from "./helpers/fixtures.js";\n'
if anchor not in text:
    raise RuntimeError("category-enricher import anchor missing")
text = text.replace(
    anchor,
    anchor + '\nconst fujiyaAvicPlugin = getShopPlugin("fujiya-avic");\nif (!fujiyaAvicPlugin) throw new Error("fujiya-avic plugin missing");\n',
)
text = text.replace("    fujiyaAvicAdapter,\n  );", "    fujiyaAvicPlugin.capabilities.catalog,\n  );")
text = text.replace("    adapter: fujiyaAvicAdapter,", "    adapter: fujiyaAvicPlugin,")
if "fujiyaAvicAdapter" in text:
    raise RuntimeError("category-enricher test still references concrete adapter")
p.write_text(text)

patch(
    "test/create-shop.test.ts",
    '    transport: "direct",\n',
    "",
)

# Hifido parser tests keep parser assertions on the adapter but transport assertions on registration.
p = Path("test/hifido.test.ts")
text = p.read_text()
anchor = 'import { isTransportConfigured } from "../src/crawler/transport.js";\n'
text = text.replace(anchor, 'import { getShopPlugin } from "../src/crawler/shops/index.js";\n' + anchor)
text = text.replace(
    anchor + '\n',
    anchor + '\nconst hifidoPlugin = getShopPlugin("hifido");\nif (!hifidoPlugin) throw new Error("hifido plugin missing");\n\n',
)
text = text.replace('  assert.equal(hifidoAdapter.transport, "relay");', '  assert.equal(hifidoPlugin.capabilities.transport?.kind, "relay");')
text = text.replace('isTransportConfigured({}, hifidoAdapter)', 'isTransportConfigured({}, hifidoPlugin.capabilities.transport?.kind)')
text = text.replace('      hifidoAdapter,\n', '      hifidoPlugin.capabilities.transport?.kind,\n')
p.write_text(text)

# Contract tests now exercise only final definition/capability/discovery forms.
p = Path("test/shop-contract.test.ts")
text = p.read_text()
text = text.replace('  assert.throws(() => registerStub({ envPrefix: "example shop" }), /SCREAMING_SNAKE_CASE/);\n', '')
text = text.replace(
    '    () => registerStub({}, { transport: "carrier-pigeon" as unknown as "direct" }),\n',
    '    () =>\n      registerStub({}, {}, { transport: { kind: "carrier-pigeon" as unknown as "direct" } }),\n',
)
text = text.replace('      assert.equal(plugin.transport, "relay");', '      assert.equal(plugin.capabilities.transport?.kind, "relay");')
text = text.replace(
    '      assert.ok(plugin.transport, `${plugin.key} grades configuration but declares no transport`);',
    '      assert.ok(\n        plugin.capabilities.transport?.kind,\n        `${plugin.key} grades configuration but declares no transport`,\n      );',
)
text = text.replace('      plugin,\n    ),', '      plugin.capabilities.transport?.kind,\n    ),')
text = text.replace('  assert.equal(isTransportConfigured({}, plugin), false);', '  assert.equal(isTransportConfigured({}, plugin.capabilities.transport?.kind), false);')
text = text.replace(
    '      coverage: "unknown" as const,\n      *initialTargets',
    '      coverage: "unknown" as const,\n      policy: { emptyPage: "stop" as const, itemCountValidation: "coverage" as const, extraPageBudget: 0 },\n      *initialTargets',
)
text = text.replace(
    '    registerStub({}, { discovery: { coverage: "complete", *initialTargets() {} } }),',
    '    registerStub(\n      {},\n      {\n        discovery: {\n          coverage: "complete",\n          policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n          *initialTargets() {},\n        },\n      },\n    ),',
)
text = text.replace(
    '      { discovery: { coverage: "complete", *initialTargets() {} } },',
    '      {\n        discovery: {\n          coverage: "complete",\n          policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },\n          *initialTargets() {},\n        },\n      },',
)
p.write_text(text)

print("Phase 3 typecheck callers migrated to final contract")
