import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { transform } from "esbuild";
import {
  createShop,
  renderAdapter,
  renderPluginRegistration,
  renderTest,
  validateShopKey,
} from "../scripts/create-shop.js";

async function assertParses(source: string, fileName: string): Promise<void> {
  try {
    await transform(source, { loader: "ts", sourcefile: fileName });
  } catch (error) {
    assert.fail(
      `${fileName} is not valid TypeScript: ${error instanceof Error ? error.message : error}`,
    );
  }
}

test("shop generator validates kebab-case keys", () => {
  assert.equal(validateShopKey("example-audio"), "example-audio");
  assert.throws(() => validateShopKey("Example_Audio"), /lowercase kebab-case/);
});

test("shop generator renders seller-fact and discovery-ready adapter", () => {
  const adapter = renderAdapter({
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
    transport: "direct",
  });
  assert.match(adapter, /SellerProduct/);
  assert.match(adapter, /discovery:/);
  assert.match(adapter, /coverage: "unknown"/);
  assert.match(adapter, /extraPageBudget: 0/);
  assert.match(adapter, /initialTargets/);
  assert.doesNotMatch(adapter, /categoryMapping|transport:/);
  assert.match(adapter, /rawManufacturer/);
  assert.match(adapter, /rawCategory/);
  assert.match(adapter, /metadata: \{ storeName, warranty \}/);
  assert.match(adapter, /exampleAudioAdapter/);
  assert.match(adapter, /satisfies ShopAdapter;/);
  assert.doesNotMatch(adapter, /pageUrls|dynamicPagination|discoverPageUrls/);

  const registration = renderPluginRegistration({
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
    intervalMinutes: 60,
  });
  assert.match(registration, /defaultIntervalMinutes: 60/);
  assert.match(registration, /transport: \{ kind: "direct" \}/);
  assert.doesNotMatch(registration, /EXAMPLE_AUDIO_INTERVAL_MINUTES:/);
});

test("a generated shop is registered but not yet crawling", () => {
  const registration = renderPluginRegistration({
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
  });
  assert.match(registration, /defaultEnabled: false/);
});

test("the generated scaffold is syntactically valid TypeScript", async () => {
  const adapter = renderAdapter({
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
  });
  const generatedTest = renderTest({ key: "example-audio" });
  const registration = renderPluginRegistration({
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
  });

  await assertParses(adapter, "example-audio.ts");
  await assertParses(generatedTest, "example-audio.test.ts");
  await assertParses(`createShopRegistry([\n${registration}]);\n`, "index.ts");
});

test("shop generator refuses a base URL the registry would reject", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "hifiscout-shop-"));
  await assert.rejects(
    createShop({ rootDir, key: "example-audio", name: "Example Audio", baseUrl: "http://x.test" }),
    /must use https/,
  );

  for (const baseUrl of [
    "https://example.com/",
    "https://example.com/catalog",
    "https://example.com?view=used",
    "https://example.com#used",
  ]) {
    await assert.rejects(
      createShop({ rootDir, key: "example-audio", name: "Example Audio", baseUrl }),
      /must be an https origin/,
    );
  }
});

test("shop generator creates adapter, fixture, test and registry entry", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "hifiscout-shop-"));
  await mkdir(join(rootDir, "src/crawler/shops"), { recursive: true });
  await mkdir(join(rootDir, "test"), { recursive: true });
  await writeFile(
    join(rootDir, "src/crawler/shops/index.ts"),
    `// shop-generator:imports\nexport const SHOP_PLUGINS = createShopRegistry([\n  // shop-generator:plugins\n]);\n`,
    "utf8",
  );

  await createShop({
    rootDir,
    key: "example-audio",
    name: "Example Audio",
    baseUrl: "https://example.com",
    intervalMinutes: 60,
  });

  const index = await readFile(join(rootDir, "src/crawler/shops/index.ts"), "utf8");
  const adapter = await readFile(join(rootDir, "src/crawler/shops/example-audio.ts"), "utf8");
  const generatedTest = await readFile(join(rootDir, "test/example-audio.test.ts"), "utf8");
  const fixture = await readFile(join(rootDir, "test/fixtures/example-audio/list.html"), "utf8");

  assert.match(index, /import \{ exampleAudioAdapter \} from "\.\/example-audio\.js"/);
  assert.match(index, /key: "example-audio"/);
  assert.match(adapter, /baseUrl: BASE_URL/);
  assert.match(adapter, /const BASE_URL = "https:\/\/example\.com"/);
  assert.match(adapter, /discovery:/);
  assert.match(adapter, /coverage: "unknown"/);
  assert.match(adapter, /extraPageBudget: 0/);
  assert.match(adapter, /parse\(_html: string\): SellerProduct\[\]/);
  assert.match(generatedTest, /\.\.\/src\/crawler\/shops\/example-audio\.js/);
  assert.match(fixture, /representative, sanitized listing-page fixture/);
  await assertParses(index, "index.ts");
  await assertParses(adapter, "example-audio.ts");
  await assertParses(generatedTest, "example-audio.test.ts");
});

test("shop generator refuses a key the registry already holds", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "hifiscout-shop-"));
  await mkdir(join(rootDir, "src/crawler/shops"), { recursive: true });
  await mkdir(join(rootDir, "test"), { recursive: true });
  await writeFile(
    join(rootDir, "src/crawler/shops/index.ts"),
    `// shop-generator:imports\nexport const SHOP_PLUGINS = createShopRegistry([\n  defineShopPlugin(exampleAudioAdapter, {\n    key: "example-audio",\n  }),\n  // shop-generator:plugins\n]);\n`,
    "utf8",
  );

  await assert.rejects(
    createShop({
      rootDir,
      key: "example-audio",
      name: "Example Audio",
      baseUrl: "https://example.com",
    }),
    /already registered/,
  );
});
