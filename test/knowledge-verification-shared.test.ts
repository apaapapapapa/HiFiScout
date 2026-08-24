import { test } from "vite-plus/test";
import assert from "node:assert/strict";

import {
  applySearchTemplate,
  boundedNumber,
  parseSourceRegistry,
} from "../src/catalog/knowledge-verification/config.js";
import {
  breadcrumbText,
  decodeHtml,
  extractSitemapLocations,
  flattenJsonLd,
  isProductNode,
  jsonLdValues,
  metaContent,
  sameOriginUrl,
  sitemapUrlsFromRobots,
  stripTags,
  visibleText,
} from "../src/catalog/knowledge-verification/html.js";
import {
  DISCOVERY_ACCEPT,
  HTML_ACCEPT,
  fetchText,
} from "../src/catalog/knowledge-verification/http.js";
import {
  candidateModelVariants,
  containsCatalogModelIdentity,
  containsFlexibleCatalogModelIdentity,
  stripManufacturerPrefix,
} from "../src/catalog/knowledge-verification/model-matching.js";

test("entity decoding survives references no code point can represent", () => {
  assert.equal(decodeHtml("A&amp;B &lt;tag&gt; &quot;q&quot; &apos;a&apos;"), `A&B <tag> "q" 'a'`);
  assert.equal(decodeHtml("&#65;&#x42;"), "AB");
  // Pre-consolidation, v1/v2 passed this straight to String.fromCodePoint and threw a RangeError,
  // which failed the whole verification. The guarded implementation leaves it alone.
  assert.equal(decodeHtml("&#1114112;"), "&#1114112;");
  assert.equal(decodeHtml("&#x110000;"), "&#x110000;");
  assert.equal(decodeHtml("&#99999999999999999999;"), "&#99999999999999999999;");
});

test("tag stripping and visible text drop scripts and styles", () => {
  assert.equal(stripTags("<p>Hello <b>world</b></p>"), "Hello world");
  assert.equal(visibleText("<script>var x = 'SA-10';</script><p>SA-11</p>"), "SA-11");
  assert.equal(visibleText("<style>.a{}</style><p>OK</p>"), "OK");
  // `stripTags` deliberately keeps script text; only `visibleText` removes it.
  assert.match(stripTags("<script>SECRET</script>"), /SECRET/u);
});

test("script removal follows the end tags a browser accepts, and only those", () => {
  // A `</script>`-only pattern leaves the script body in the text, and script bodies routinely
  // mention model numbers and availability wording that the classifier would then read as page
  // content. `inventory-recheck` already guarded this; the shared helper now does too.
  for (const closing of ["</script>", "</script >", "</script\t\n data-x>"]) {
    assert.equal(visibleText(`<script>SA-10 在庫あり${closing}<p>SA-11</p>`), "SA-11", closing);
  }
  assert.equal(visibleText("<style>.a{}</style ><p>OK</p>"), "OK");

  // `</script-x>` is a different tag name, so a browser keeps reading script. Ending the strip
  // there would release the rest of the script — prices included — into the visible text.
  assert.equal(
    visibleText(`<script>var s = "</script-x>"; var price = 999;</script><p>SA-11</p>`),
    "SA-11",
  );
  // A no-break space is whitespace to JavaScript's `\s` but not to an HTML tokenizer.
  assert.equal(
    visibleText(`<script>var s = "</script\u00a0>"; var price = 999;</script><p>SA-11</p>`),
    "SA-11",
  );
  assert.equal(visibleText(`<style>.a:after{content:"</style-x>"}</style><p>OK</p>`), "OK");
});

test("model identity is bounded so a shorter model never matches inside a longer one", () => {
  assert.equal(containsCatalogModelIdentity("Marantz SA-10 player", "SA-10"), true);
  assert.equal(containsCatalogModelIdentity("Marantz SA-100 player", "SA-10"), false);
  assert.equal(containsCatalogModelIdentity("", "SA-10"), false);
  assert.equal(containsCatalogModelIdentity("SA-10", ""), false);
});

test("model identity treats punctuation inside a model as significant", () => {
  assert.equal(containsCatalogModelIdentity("Version 2.5 digital player", "2.5"), true);
  assert.equal(containsCatalogModelIdentity("Version 25 digital player", "2.5"), false);
});

test("flexible identity tolerates separator drift but keeps the same boundaries", () => {
  for (const text of ["LUXMAN L-507Z", "LUXMAN L 507Z", "LUXMAN L507Z", "luxman l_507z"]) {
    assert.equal(containsFlexibleCatalogModelIdentity(text, "L-507Z"), true, text);
  }
  assert.equal(containsFlexibleCatalogModelIdentity("LUXMAN L-507ZX", "L-507Z"), false);
  // Full-width and en-dash variants normalize to ASCII before matching.
  assert.equal(containsFlexibleCatalogModelIdentity("LUXMAN L–507Z", "L-507Z"), true);
  // Drift in the other direction too: the official name spaces what the listing runs together.
  assert.equal(containsFlexibleCatalogModelIdentity("Marantz SACD30n", "SACD 30n"), true);
  assert.equal(containsFlexibleCatalogModelIdentity("LUXMAN D10X", "D-10X"), true);
  assert.equal(containsFlexibleCatalogModelIdentity("ESOTERIC K-01XD", "K-01X"), false);
});

test("manufacturer prefixes are stripped only at a token boundary", () => {
  assert.equal(stripManufacturerPrefix("LUXMAN L-507Z", "LUXMAN"), "L-507Z");
  assert.equal(stripManufacturerPrefix("LUXMANIA 1", "LUXMAN"), "");
  assert.equal(stripManufacturerPrefix("L-507Z", "LUXMAN"), "");
});

test("candidate variants cover both the listing and official spellings, longest first", () => {
  const variants = candidateModelVariants({
    observedManufacturer: "LUXMAN",
    manufacturerId: "luxman",
    observedModel: "LUXMAN L-507Z",
    normalizedModel: "L507Z",
  });

  assert.ok(variants.includes("LUXMAN L-507Z"));
  assert.ok(variants.includes("L-507Z"));
  assert.ok(variants.includes("L507Z"));
  assert.deepEqual(
    variants,
    [...variants].sort((a, b) => b.length - a.length),
  );
});

test("candidate variants strip a hyphen-joined manufacturer prefix conservatively", () => {
  assert.deepEqual(
    candidateModelVariants({
      manufacturerId: "tad",
      observedManufacturer: "TAD",
      observedModel: "TAD-D1000TX",
    }),
    ["TAD-D1000TX", "D1000TX"],
  );
});

test("JSON-LD reading skips malformed blocks and flattens @graph containers", () => {
  const html = `
    <script type="application/ld+json">{"@type":"Product","name":"A"}</script>
    <script type="application/ld+json">{ not json }</script>
    <script type="application/ld+json">{"@graph":[{"@type":["Thing","Product"],"name":"B"}]}</script>
    <script type="application/ld+json" data-hydrate>{"@type":"Product","name":"C"}</script data-astro>
    <script-x type="application/ld+json">{"@type":"Product","name":"D"}</script-x>`;
  const nodes = jsonLdValues(html).flatMap((value) => flattenJsonLd(value));
  const products = nodes.filter(isProductNode);

  // C closes the way a browser accepts; D is a different tag name and is not JSON-LD at all.
  assert.equal(products.length, 3);
  assert.deepEqual(
    products.map((node) => node.name),
    ["A", "B", "C"],
  );
});

test("page metadata extraction reads meta names and breadcrumb trails", () => {
  assert.equal(
    metaContent('<meta name="description" content="A &amp; B">', "description"),
    "A & B",
  );
  assert.equal(metaContent("<meta name=description content=X>", "DESCRIPTION"), "X");
  assert.equal(metaContent("<meta name=other content=X>", "description"), "");
  assert.equal(
    breadcrumbText('<nav class="breadcrumb"><a>Home</a><a>Amplifiers</a></nav>'),
    "Home Amplifiers",
  );
});

test("link resolution refuses to leave the manufacturer's origin", () => {
  const base = "https://example.test/products/";
  assert.equal(sameOriginUrl("/a", base), "https://example.test/a");
  assert.equal(sameOriginUrl("a#frag", base), "https://example.test/products/a");
  assert.equal(sameOriginUrl("https://other.test/a", base), "");
  assert.equal(sameOriginUrl("javascript:alert(1)", base), "");
  assert.equal(sameOriginUrl("not a url", "also not a url"), "");
});

test("sitemap discovery stays same-origin and skips gzipped sitemaps", () => {
  const base = "https://example.test/";
  assert.deepEqual(
    extractSitemapLocations(
      "<urlset><url><loc>https://example.test/a</loc></url><url><loc>https://other.test/b</loc></url></urlset>",
      base,
    ),
    ["https://example.test/a"],
  );
  assert.deepEqual(
    sitemapUrlsFromRobots(
      "Sitemap: https://example.test/s.xml\nSitemap: https://example.test/s.xml.gz\nDisallow: /",
      base,
    ),
    ["https://example.test/s.xml"],
  );
});

test("bounded numbers clamp rather than trusting a deployment variable", () => {
  assert.equal(boundedNumber("5000", 8000, 1000, 20000), 5000);
  assert.equal(boundedNumber("999999", 8000, 1000, 20000), 20000);
  assert.equal(boundedNumber("1", 8000, 1000, 20000), 1000);
  assert.equal(boundedNumber("abc", 8000, 1000, 20000), 8000);
  assert.equal(boundedNumber(undefined, 8000, 1000, 20000), 8000);
});

test("a malformed source registry disables the override instead of failing verification", () => {
  assert.deepEqual(parseSourceRegistry(undefined), []);
  assert.deepEqual(parseSourceRegistry("{ not json"), []);
  assert.deepEqual(parseSourceRegistry('[{"manufacturerId":"luxman"}]'), [
    { manufacturerId: "luxman" },
  ]);
  // The object form is keyed by manufacturer id and is normalized into the array form.
  assert.deepEqual(parseSourceRegistry('{"luxman":{"baseUrl":"https://x.test/"}}'), [
    { manufacturerId: "luxman", baseUrl: "https://x.test/" },
  ]);
});

test("search templates percent-encode the values they interpolate", () => {
  assert.equal(
    applySearchTemplate("https://x.test/?q={model}&b={manufacturer}", {
      observedModel: "L-507Z & more",
      observedManufacturer: "A/B",
    }),
    "https://x.test/?q=L-507Z%20%26%20more&b=A%2FB",
  );
  assert.equal(applySearchTemplate("", { observedModel: "x" }), "");
});

test("a fetch failure is reported, never thrown, and the accept header is caller-chosen", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen.push(String((init.headers as Record<string, string>).accept));
    return new Response("<html>ok</html>", { status: 200 });
  }) as unknown as typeof fetch;

  const options = { timeoutMs: 1000, maxBytes: 1000, userAgent: "TestBot" };
  await fetchText(fetchImpl, "https://x.test/", options);
  await fetchText(fetchImpl, "https://x.test/", { ...options, accept: HTML_ACCEPT });
  assert.deepEqual(seen, [DISCOVERY_ACCEPT, HTML_ACCEPT]);

  const failing = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  const result = await fetchText(failing, "https://x.test/", options);
  assert.deepEqual(result, {
    ok: false,
    status: 0,
    url: "https://x.test/",
    text: "",
    error: "network down",
  });
});

test("response bodies are truncated at the configured byte cap", async () => {
  const body = "a".repeat(5000);
  const fetchImpl = (async () => new Response(body, { status: 200 })) as unknown as typeof fetch;

  const result = await fetchText(fetchImpl, "https://x.test/", {
    timeoutMs: 1000,
    maxBytes: 100,
    userAgent: "TestBot",
  });

  assert.equal(result.ok, true);
  assert.equal(result.text.length, 100);
});
