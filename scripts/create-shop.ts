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
}

interface PluginRegistrationOptions {
  key: string;
  name: string;
  baseUrl: string;
  transport?: ShopTransport;
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

/** Scaffold a disabled, bounded shop against the final Phase 3 platform contract. */
export function renderAdapter({ key, name, baseUrl }: AdapterTemplateOptions): string {
  const identifier = adapterIdentifier(key);
  return `import type { SellerProduct, ShopAdapter } from "../types.js";

const BASE_URL = ${quote(baseUrl)};

/**
 * ${name}.
 *
 * Report seller facts only. Canonical manufacturer/category resolution, product identity,
 * persistence, search projection, evidence and data quality are the platform's responsibility.
 */
export const ${identifier} = {
  key: ${quote(key)},
  name: ${quote(name)},
  baseUrl: BASE_URL,
  discovery: {
    // Keep the scaffold non-destructive until the seller's coverage semantics are understood.
    coverage: "unknown",
    policy: { emptyPage: "stop", itemCountValidation: "coverage", extraPageBudget: 0 },
    *initialTargets(): Generator<string> {
      // TODO: replace with this shop's used-listing entry points.
      yield BASE_URL;
    },
  },
  parse(_html: string): SellerProduct[] {
    // TODO: return one entry per listing. The raw seller fields are required by the platform:
    // { sourceId, sourceUrl, title, rawManufacturer, manufacturer, model, rawCategory, category,
    //   conditionText, priceYen, stockStatus, metadata: { storeName, warranty } }
    return [];
  },
} satisfies ShopAdapter;
`;
}

export function renderTest({ key }: Pick<AdapterTemplateOptions, "key">): string {
  const identifier = adapterIdentifier(key);
  return `import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { ${identifier} } from "../src/crawler/shops/${key}.js";

test("${key} adapter scaffold is wired", async () => {
  const fixture = await readFile(
    new URL("./fixtures/${key}/list.html", import.meta.url),
    "utf8",
  );
  assert.equal(${identifier}.key, ${quote(key)});
  assert.equal(${identifier}.discovery.coverage, "unknown");
  assert.ok(${identifier}.baseUrl);
  assert.deepEqual(${identifier}.parse(fixture), []);
});
`;
}

/** The empty scaffold is registered but disabled until its parser and fixtures are complete. */
export function renderPluginRegistration({
  key,
  name,
  baseUrl,
  transport = "direct",
  intervalMinutes = 60,
}: PluginRegistrationOptions): string {
  const identifier = adapterIdentifier(key);
  const prefix = envPrefix(key);
  return `  defineShopPlugin(${identifier}, {
    key: ${quote(key)},
    name: ${quote(name)},
    baseUrl: ${quote(baseUrl)},
    defaultIntervalMinutes: ${intervalMinutes},
    // The scaffold parser returns nothing. Drop this line (or set ${prefix}_ENABLED) only once a
    // real parser and a representative fixture are in place.
    defaultEnabled: false,
  }, {
    transport: { kind: ${quote(transport)} },
  }),
`;
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
  if (parsedBaseUrl.protocol !== "https:") throw new Error("base URL must use https");
  if (baseUrl !== parsedBaseUrl.origin) {
    throw new Error(
      "base URL must be an https origin with no path, query, fragment or trailing slash",
    );
  }
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
  if (index.includes(`key: ${quote(shopKey)}`) || index.includes(`./${shopKey}.js`)) {
    throw new Error(`shop already registered: ${shopKey}`);
  }

  const identifier = adapterIdentifier(shopKey);
  index = index.replace(
    IMPORT_MARKER,
    `import { ${identifier} } from "./${shopKey}.js";\n${IMPORT_MARKER}`,
  );
  index = index.replace(
    PLUGIN_MARKER,
    `${renderPluginRegistration({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin, transport, intervalMinutes })}${PLUGIN_MARKER}`,
  );

  await mkdir(dirname(adapterPath), { recursive: true });
  await mkdir(fixtureDir, { recursive: true });
  await Promise.all([
    writeFile(
      adapterPath,
      renderAdapter({ key: shopKey, name: name.trim(), baseUrl: parsedBaseUrl.origin }),
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
  const prefix = envPrefix(validateShopKey(args.key));
  console.log(`Created shop ${args.key}`);
  console.log(`- ${result.adapterPath}`);
  console.log(`- ${result.testPath}`);
  console.log(`- ${result.fixturePath}`);
  console.log(`- registered in ${result.indexPath}`);
  console.log(
    `Next: add a representative sanitized fixture, replace the scaffold parser, run npm test,\n` +
      `then remove defaultEnabled: false (or set ${prefix}_ENABLED) to let the shop crawl.\n` +
      `Its settings are ${prefix}_ENABLED / _INTERVAL_MINUTES / _REQUEST_DELAY_MS / _MAX_PAGES;\n` +
      `declare deployed values in wrangler.jsonc, not new names in the crawler types.`,
  );
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
