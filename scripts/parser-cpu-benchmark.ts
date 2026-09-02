/**
 * Offline parser CPU regression gate.
 *
 * The absolute microsecond values are diagnostic only: CI runners vary too much for them to be a
 * trustworthy gate. Each parser stage is instead divided by a deterministic, input-shaped scan in
 * the same Node process, then compared with a source-controlled relative baseline. Production
 * Workers Observability p95/p99 CPU remains authoritative; the fixture gate catches large code
 * regressions before deployment without contacting a seller.
 */

import { readFile } from "node:fs/promises";

import { normalizeCatalogProducts } from "../src/catalog/product-normalizer.js";
import {
  discoverDynamicAudioPageUrls,
  parseDynamicAudioListing,
} from "../src/crawler/shops/dynamic-audio.js";
import {
  HIFIDO_CATEGORY_MAPPING,
  HIFIDO_CATEGORY_POLICY,
  parseHifidoListing,
} from "../src/crawler/shops/hifido.js";
import { discoverRewirePageUrls, parseRewireListing } from "../src/crawler/shops/rewire.js";
import type { CatalogCapability, SellerProduct } from "../src/crawler/types.js";

type BenchmarkStage = "parse" | "normalize" | "discover";

interface ParserFixtureCase {
  readonly shopKey: string;
  readonly fixtureUrl: URL;
  readonly minimumItems: number;
  readonly minimumDiscoveredPages?: number;
  readonly catalog?: CatalogCapability;
  parse(html: string): SellerProduct[];
  discover?(html: string): readonly unknown[];
}

interface CpuMeasurement {
  readonly cpuUsPerIteration: number;
  readonly relativeToReference: number;
}

interface BenchmarkResult extends CpuMeasurement {
  readonly shopKey: string;
  readonly stage: BenchmarkStage;
  readonly htmlBytes: number;
  readonly parsedItems: number;
  readonly cpuUsPerKib: number;
  readonly cpuUsPerItem: number;
  readonly baselineRelativeToReference: number;
  readonly maxRelativeToReference: number;
}

const FIXTURES: readonly ParserFixtureCase[] = [
  {
    shopKey: "dynamic-audio",
    fixtureUrl: new URL("../test/fixtures/dynamic-audio/list.html", import.meta.url),
    minimumItems: 3,
    minimumDiscoveredPages: 2,
    parse: parseDynamicAudioListing,
    discover: (html) => discoverDynamicAudioPageUrls(html, 1),
  },
  {
    shopKey: "hifido",
    fixtureUrl: new URL("../test/fixtures/parser-cpu/hifido-list.html", import.meta.url),
    minimumItems: 8,
    catalog: {
      categoryMapping: HIFIDO_CATEGORY_MAPPING,
      categoryPolicy: HIFIDO_CATEGORY_POLICY,
    },
    parse: parseHifidoListing,
  },
  {
    shopKey: "rewire",
    fixtureUrl: new URL("../test/fixtures/parser-cpu/rewire-list.html", import.meta.url),
    minimumItems: 10,
    minimumDiscoveredPages: 12,
    parse: parseRewireListing,
    discover: (html) =>
      discoverRewirePageUrls(html, {
        url: "https://rewire.co.jp/webshop/category/item/usedvintage/",
        page: 1,
      }),
  },
];

/**
 * Median ratios captured with Node 22 after warm-up. A candidate may use 75% more CPU relative to
 * its same-process reference before CI fails; the additive margin protects very small stages from
 * timer granularity. Updating a baseline is an explicit reviewable performance decision.
 */
const BASELINE_RELATIVE_CPU: Readonly<
  Record<string, Readonly<Partial<Record<BenchmarkStage, number>>>>
> = Object.freeze({
  "dynamic-audio": Object.freeze({ parse: 20, normalize: 1900, discover: 0.7 }),
  hifido: Object.freeze({ parse: 9, normalize: 2300 }),
  rewire: Object.freeze({ parse: 55, normalize: 1900, discover: 3.3 }),
});

const MAX_RELATIVE_REGRESSION = 1.75;
const RELATIVE_NOISE_MARGIN = 0.5;
const TARGET_SAMPLE_CPU_US = 50_000;
const MIN_CALIBRATION_CPU_US = 2_000;
const MIN_SAMPLE_ITERATIONS = 3;
const SAMPLE_COUNT = 5;
const MAX_ITERATIONS = 131_072;

let benchmarkSink = 0;

function consume(value: unknown): void {
  const contribution = Array.isArray(value)
    ? value.length
    : typeof value === "number"
      ? value
      : String(value ?? "").length;
  benchmarkSink = (benchmarkSink + contribution) % 2_147_483_647;
}

function runCpuBatch(operation: () => unknown, iterations: number): number {
  const started = process.cpuUsage();
  for (let index = 0; index < iterations; index += 1) consume(operation());
  const elapsed = process.cpuUsage(started);
  return elapsed.user + elapsed.system;
}

function calibratedIterations(operation: () => unknown): number {
  for (let iterations = 1; iterations <= MAX_ITERATIONS; iterations *= 2) {
    const cpuUs = runCpuBatch(operation, iterations);
    if (cpuUs < MIN_CALIBRATION_CPU_US) continue;
    return Math.max(
      MIN_SAMPLE_ITERATIONS,
      Math.min(MAX_ITERATIONS, Math.round((iterations * TARGET_SAMPLE_CPU_US) / cpuUs)),
    );
  }
  return MAX_ITERATIONS;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function measureCpu(operation: () => unknown, reference: () => unknown): CpuMeasurement {
  // Registration/module startup and the first regex compilation are not per-page production cost.
  for (let index = 0; index < 20; index += 1) {
    consume(operation());
    consume(reference());
  }

  const operationIterations = calibratedIterations(operation);
  const referenceIterations = calibratedIterations(reference);
  const operationSamples: number[] = [];
  const referenceSamples: number[] = [];

  for (let sample = 0; sample < SAMPLE_COUNT; sample += 1) {
    // Alternate order so thermal/scheduler drift does not consistently favor either side.
    if (sample % 2 === 0) {
      referenceSamples.push(runCpuBatch(reference, referenceIterations) / referenceIterations);
      operationSamples.push(runCpuBatch(operation, operationIterations) / operationIterations);
    } else {
      operationSamples.push(runCpuBatch(operation, operationIterations) / operationIterations);
      referenceSamples.push(runCpuBatch(reference, referenceIterations) / referenceIterations);
    }
  }

  const cpuUsPerIteration = median(operationSamples);
  const referenceCpuUsPerIteration = median(referenceSamples);
  return {
    cpuUsPerIteration,
    relativeToReference:
      referenceCpuUsPerIteration > 0
        ? cpuUsPerIteration / referenceCpuUsPerIteration
        : Number.POSITIVE_INFINITY,
  };
}

/** One deterministic linear HTML pass, used only to normalize runner speed. */
function referenceHtmlScan(html: string): number {
  let checksum = 0;
  for (const match of html.matchAll(/<[^>]*>|[^<]+/gu)) {
    checksum = (checksum + match[0].length + (match.index ?? 0)) % 2_147_483_647;
  }
  return checksum;
}

/** One deterministic string-normalization pass over the parser output. */
function referenceProductScan(products: readonly SellerProduct[]): number {
  let checksum = 0;
  for (const product of products) {
    const value = [
      product.sourceId,
      product.title,
      product.rawManufacturer,
      product.model,
      product.rawCategory,
      product.conditionText,
    ]
      .join(" ")
      .normalize("NFKC")
      .replace(/\s+/gu, " ")
      .trim();
    checksum = (checksum + value.length) % 2_147_483_647;
  }
  return checksum;
}

function threshold(
  shopKey: string,
  stage: BenchmarkStage,
): {
  baseline: number;
  maximum: number;
} {
  const baseline = BASELINE_RELATIVE_CPU[shopKey]?.[stage];
  if (!(baseline && Number.isFinite(baseline))) {
    throw new Error(`missing parser CPU baseline for ${shopKey}/${stage}`);
  }
  return {
    baseline,
    maximum: baseline * MAX_RELATIVE_REGRESSION + RELATIVE_NOISE_MARGIN,
  };
}

function result(
  fixture: ParserFixtureCase,
  stage: BenchmarkStage,
  htmlBytes: number,
  parsedItems: number,
  measurement: CpuMeasurement,
): BenchmarkResult {
  const gate = threshold(fixture.shopKey, stage);
  return {
    shopKey: fixture.shopKey,
    stage,
    htmlBytes,
    parsedItems,
    cpuUsPerIteration: Number(measurement.cpuUsPerIteration.toFixed(3)),
    relativeToReference: Number(measurement.relativeToReference.toFixed(3)),
    cpuUsPerKib: Number((measurement.cpuUsPerIteration / (htmlBytes / 1024)).toFixed(3)),
    cpuUsPerItem: Number((measurement.cpuUsPerIteration / parsedItems).toFixed(3)),
    baselineRelativeToReference: gate.baseline,
    maxRelativeToReference: Number(gate.maximum.toFixed(3)),
  };
}

async function benchmarkFixture(fixture: ParserFixtureCase): Promise<BenchmarkResult[]> {
  const html = await readFile(fixture.fixtureUrl, "utf8");
  const htmlBytes = Buffer.byteLength(html);
  const sellerProducts = fixture.parse(html);
  if (sellerProducts.length < fixture.minimumItems) {
    throw new Error(
      `${fixture.shopKey} CPU fixture parsed ${sellerProducts.length} items; expected at least ${fixture.minimumItems}`,
    );
  }

  const normalized = normalizeCatalogProducts(sellerProducts, fixture.catalog || {}, {
    shopKey: fixture.shopKey,
  });
  if (normalized.length !== sellerProducts.length) {
    throw new Error(`${fixture.shopKey} normalization changed the fixture item count`);
  }

  const htmlReference = () => referenceHtmlScan(html);
  const productReference = () => referenceProductScan(sellerProducts);
  const results = [
    result(
      fixture,
      "parse",
      htmlBytes,
      sellerProducts.length,
      measureCpu(() => fixture.parse(html), htmlReference),
    ),
    result(
      fixture,
      "normalize",
      htmlBytes,
      sellerProducts.length,
      measureCpu(
        () =>
          normalizeCatalogProducts(sellerProducts, fixture.catalog || {}, {
            shopKey: fixture.shopKey,
          }),
        productReference,
      ),
    ),
  ];

  if (fixture.discover) {
    const discovered = fixture.discover(html);
    if (discovered.length < (fixture.minimumDiscoveredPages || 0)) {
      throw new Error(
        `${fixture.shopKey} CPU fixture discovered ${discovered.length} pages; expected at least ${fixture.minimumDiscoveredPages}`,
      );
    }
    results.push(
      result(
        fixture,
        "discover",
        htmlBytes,
        sellerProducts.length,
        measureCpu(() => fixture.discover?.(html) || [], htmlReference),
      ),
    );
  }
  return results;
}

const check = process.argv.includes("--check");
const results: BenchmarkResult[] = [];
for (const fixture of FIXTURES) results.push(...(await benchmarkFixture(fixture)));

for (const item of results) {
  console.log(JSON.stringify({ event: "parser_cpu_benchmark", ...item }));
}

if (check) {
  const regressions = results.filter(
    (item) => item.relativeToReference > item.maxRelativeToReference,
  );
  if (regressions.length) {
    for (const item of regressions) {
      console.error(
        `${item.shopKey}/${item.stage} relative CPU ${item.relativeToReference} exceeded ${item.maxRelativeToReference}`,
      );
    }
    process.exitCode = 1;
  }
}

// Keep the consumer observable to V8 without polluting the normal report.
if (benchmarkSink < 0) console.log(benchmarkSink);
