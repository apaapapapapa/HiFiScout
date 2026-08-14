from pathlib import Path

path = Path('.github/scripts/phase3_complete_migration.py')
text = path.read_text()

start = text.index("replace(\n    'scripts/create-shop.ts',\n    '''${renderPluginRegistration")
end = text.index("\nreplace(\n    'scripts/create-shop.ts',\n    '''      renderAdapter", start)
replacement = '''replace(\n    'scripts/create-shop.ts',\n    """    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, intervalMinutes })}${PLUGIN_MARKER}`,\\n""",\n    """    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport, intervalMinutes })}${PLUGIN_MARKER}`,\\n""",\n)\n'''
text = text[:start] + replacement + text[end + 1:]

old = "replace('src/crawler/types.ts', '  ShopParsedProduct,\\n', '  FeatureFactInput,\\n')"
new = '''replace(\n    'src/crawler/types.ts',\n    '  NormalizedCatalogProduct,\\n  ShopParsedProduct,\\n  StockStatus,\\n',\n    '  FeatureFactInput,\\n  NormalizedCatalogProduct,\\n  StockStatus,\\n',\n)'''
if old not in text:
    raise RuntimeError('crawler type import replacement not found')
text = text.replace(old, new)

old = "text = text.replace('registerStub({ envPrefix: \\\"example shop\\\" }), /SCREAMING_SNAKE_CASE/);\\\\n', '')"
if old not in text:
    old = "text = text.replace('registerStub({ envPrefix: \"example shop\" }), /SCREAMING_SNAKE_CASE/);\\n', '')"
new = "text = text.replace('  assert.throws(() => registerStub({ envPrefix: \\\"example shop\\\" }), /SCREAMING_SNAKE_CASE/);\\\\n', '')"
if old not in text:
    raise RuntimeError('envPrefix test transform not found')
text = text.replace(old, new)

path.write_text(text)
print('fixed phase3 transform script')
