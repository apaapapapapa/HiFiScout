import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShop, renderAdapter, renderPluginRegistration, validateShopKey } from '../scripts/create-shop.mjs';

test('shop generator validates kebab-case keys', () => {
  assert.equal(validateShopKey('example-audio'), 'example-audio');
  assert.throws(() => validateShopKey('Example_Audio'), /lowercase kebab-case/);
});

test('shop generator renders metadata-ready adapter and registration', () => {
  const adapter = renderAdapter({
    key: 'example-audio',
    name: 'Example Audio',
    baseUrl: 'https://example.com',
    transport: 'direct'
  });
  assert.match(adapter, /metadata: \{ storeName, warranty \}/);
  assert.match(adapter, /exampleAudioAdapter/);

  const registration = renderPluginRegistration({
    key: 'example-audio',
    name: 'Example Audio',
    baseUrl: 'https://example.com',
    intervalMinutes: 60
  });
  assert.match(registration, /EXAMPLE_AUDIO_INTERVAL_MINUTES/);
  assert.match(registration, /defaultIntervalMinutes: 60/);
});

test('shop generator creates adapter, fixture, test and registry entry', async () => {
  const rootDir = await mkdtemp(join(tmpdir(), 'hifiscout-shop-'));
  await mkdir(join(rootDir, 'src/crawler/shops'), { recursive: true });
  await mkdir(join(rootDir, 'test'), { recursive: true });
  await writeFile(join(rootDir, 'src/crawler/shops/index.js'), `// shop-generator:imports\nexport const SHOP_PLUGINS = [\n  // shop-generator:plugins\n];\n`, 'utf8');

  await createShop({
    rootDir,
    key: 'example-audio',
    name: 'Example Audio',
    baseUrl: 'https://example.com/catalog',
    intervalMinutes: 60
  });

  const index = await readFile(join(rootDir, 'src/crawler/shops/index.js'), 'utf8');
  const adapter = await readFile(join(rootDir, 'src/crawler/shops/example-audio.js'), 'utf8');
  const fixture = await readFile(join(rootDir, 'test/fixtures/example-audio/list.html'), 'utf8');

  assert.match(index, /import \{ exampleAudioAdapter \} from '\.\/example-audio\.js'/);
  assert.match(index, /key: 'example-audio'/);
  assert.match(adapter, /baseUrl: "https:\/\/example\.com"/);
  assert.match(fixture, /representative, sanitized listing-page fixture/);
});
