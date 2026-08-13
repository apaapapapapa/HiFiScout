import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const IMPORT_MARKER = "// shop-generator:imports";
const PLUGIN_MARKER = "  // shop-generator:plugins";

type ShopTransport = "direct" | "relay" | "browser";

interface AdapterTemplateOptions {
  key: string;
  name: string;
  baseUrl: string;
  transport?: ShopTransport;
}

interface PluginRegistrationOptions {
  key: string;
  name: string;
  baseUrl: string;
  intervalMinutes?: number;
}

interface CreateShopOptions {
  rootDir?: string;
  key?: string;
  name?: string;
  baseUrl?: string;
  transport?: string;
  intervalMinutes?: number;
}

export function validateShopKey(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)) {
    throw new Error("shop key must use lowercase kebab-case, e.g. example-audio");
  }
  return value;
}

function adapterIdentifier(key: string): string {
  const camel = key.replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
  return `${camel}Adapter`;
}

function envPrefix(key: string): string {
  return key.replaceAll("-", "_").toUpperCase();
}

function quote(value: string): string {
  return JSON.stringify(value);
}

function isShopTransport(value: string): value is ShopTransport {
  return value === "direct" || value === "relay" || value === "browser";
}

export function renderAdapter({
  key,
  name,
  baseUrl,
  transport = "direct",
}: AdapterTemplateOptions): string {
  const identifier = adapterIdentifier(key);
  return `export const ${identifier} = {\n  key: ${quote(key)},\n  name: ${quote(name)},\n  baseUrl: ${quote(baseUrl)},\n  transport: ${quote(transport)},\n  // Map seller category labels to canonical IDs from src/catalog/categories.ts.\n  // The first ID is the primary category when an item belongs to multiple categories.\n  categoryMapping: {\n    // 'Seller category': 'canonical_category_id',\n    // 'Network DAC': ['dac', 'network_player']\n  },\n  *pageUrls() {\n    // TODO: replace with the shop's actual used-product listing URL(s).\n    yield this.baseUrl;\n  },\n  parse(_html: string) {\n    // TODO: parse factual listing fields only. Preserve rawManufacturer/rawCategory when available.\n    // Shop-specific fields belong in metadata. Canonical catalog fields are added centrally.\n    // Example item: { sourceId, rawManufacturer, manufacturer, model, title, rawCategory, category,\n    //   conditionText, priceYen, stockStatus, sourceUrl, metadata: { storeName, warranty } }\n    return [];\n  }\n};\n`;
}

export function renderTest({ key }: Pick<AdapterTemplateOptions, "key">): string {
  const identifier = adapterIdentifier(key);
  return `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { readFile } from 'node:fs/promises';\nimport { ${identifier} } from '../src/crawler/shops/${key}.js';\n\ntest('${key} adapter scaffold is wired', async () => {\n  const fixture = await readFile(new URL('./fixtures/${key}/list.html', import.meta.url), 'utf8');\n  assert.equal(${identifier}.key, ${quote(key)});\n  assert.ok(${identifier}.baseUrl);\n  assert.deepEqual(${identifier}.parse(fixture), []);\n});\n`;
}

export function renderPluginRegistration({
  key,
  name,
  baseUrl,
  intervalMinutes = 60,
}: PluginRegistrationOptions): string {
  const identifier = adapterIdentifier(key);
  const prefix = envPrefix(key);
  return `  defineShopPlugin(${identifier}, {\n    key: ${quote(key)}, name: ${quote(name)}, baseUrl: ${quote(baseUrl)},\n    intervalEnv: '${prefix}_INTERVAL_MINUTES', enabledEnv: '${prefix}_ENABLED',\n    requestDelayEnv: '${prefix}_REQUEST_DELAY_MS', defaultIntervalMinutes: ${intervalMinutes}\n  }),\n`;
}

async function assertMissing(path: string): Promise<void> {
  try {
    await access(path, fsConstants.F_OK);
    throw new Error(`refusing to overwrite existing path: ${path}`);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export async function createShop({
  rootDir = process.cwd(),
  key,
  name,
  baseUrl,
  transport = "direct",
  intervalMinutes = 60,
}: CreateShopOptions) {
  const shopKey = validateShopKey(key);
  if (!name?.trim()) throw new Error("shop name is required");
  if (!baseUrl) throw new Error("base URL is required");
  const parsedBaseUrl = new URL(baseUrl);
  if (!["http:", "https:"].includes(parsedBaseUrl.protocol))
    throw new Error("base URL must use http or https");
  if (!isShopTransport(transport)) throw new Error("transport must be direct, relay, or browser");
  if (!Number.isInteger(intervalMinutes) || intervalMinutes <= 0)
    throw new Error("interval must be a positive integer");

  const adapterPath = resolve(rootDir, "src/crawler/shops", `${shopKey}.ts`);
  const testPath = resolve(rootDir, "test", `${shopKey}.test.ts`);
  const fixtureDir = resolve(rootDir, "test/fixtures", shopKey);
  const fixturePath = resolve(fixtureDir, "list.html");
  const indexPath = resolve(rootDir, "src/crawler/shops/index.ts");

  await Promise.all([
    assertMissing(adapterPath),
    assertMissing(testPath),
    assertMissing(fixturePath),
  ]);
  let index = await readFile(indexPath, "utf8");
  if (!index.includes(IMPORT_MARKER) || !index.includes(PLUGIN_MARKER)) {
    throw new Error("shop registry generator markers are missing");
  }
  if (index.includes(`key: '${shopKey}'`) || index.includes(`./${shopKey}.js`)) {
    throw new Error(`shop already registered: ${shopKey}`);
  }

  const identifier = adapterIdentifier(shopKey);
  index = index.replace(
    IMPORT_MARKER,
    `import { ${identifier} } from './${shopKey}.js';\n${IMPORT_MARKER}`,
  );
  index = index.replace(
    PLUGIN_MARKER,
    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, intervalMinutes })}${PLUGIN_MARKER}`,
  );

  await mkdir(dirname(adapterPath), { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  await Promise.all([
    writeFile(
      adapterPath,
      renderAdapter({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport }),
      "utf8",
    ),
    writeFile(testPath, renderTest({ key: shopKey }), "utf8"),
    writeFile(
      fixturePath,
      "<!-- Replace with a representative, sanitized listing-page fixture. -->\n",
      "utf8",
    ),
  ]);
  await writeFile(indexPath, index, "utf8");

  return { adapterPath, testPath, fixturePath, indexPath };
}

function parseArgs(argv: string[]): Record<string, string | undefined> {
  const values: Record<string, string | undefined> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
    values[key] = argv[i + 1];
    i += 1;
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const intervalMinutes = Number.parseInt(args.interval || "60", 10);
  const result = await createShop({
    key: args.key,
    name: args.name,
    baseUrl: args["base-url"],
    transport: args.transport || "direct",
    intervalMinutes,
  });
  console.log(`Created shop ${args.key}`);
  console.log(`- ${result.adapterPath}`);
  console.log(`- ${result.testPath}`);
  console.log(`- ${result.fixturePath}`);
  console.log(
    "Next: replace the scaffold parser, add a representative fixture, then run npm test.",
  );
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
