from pathlib import Path

path = Path('.github/scripts/phase3_complete_migration.py')
text = path.read_text()
start = text.index("replace(\n    'scripts/create-shop.ts',\n    '''${renderPluginRegistration")
end = text.index("\nreplace(\n    'scripts/create-shop.ts',\n    '''      renderAdapter", start)
replacement = '''replace(\n    'scripts/create-shop.ts',\n    """    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, intervalMinutes })}${PLUGIN_MARKER}`,\\n""",\n    """    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport, intervalMinutes })}${PLUGIN_MARKER}`,\\n""",\n)\n'''
path.write_text(text[:start] + replacement + text[end + 1:])
print('fixed phase3 transform script')
