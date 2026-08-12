import { normalizeManufacturer } from "../catalog/manufacturers.js";
import {
  cleanText,
  inferCategory,
  inferStockStatus,
  parseYen,
  splitManufacturerModel,
  stableSourceId,
} from "./normalize.js";

function decodeJsonLd(html) {
  const results = [];
  const re = /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const match of html.matchAll(re)) {
    try {
      results.push(JSON.parse(match[1].trim()));
    } catch {
      // Ignore malformed third-party JSON-LD and continue to the HTML fallback.
    }
  }
  return results;
}

function walkJson(value, visitor) {
  if (!value) return;
  if (Array.isArray(value)) {
    for (const item of value) walkJson(item, visitor);
    return;
  }
  if (typeof value === "object") {
    visitor(value);
    for (const child of Object.values(value)) walkJson(child, visitor);
  }
}

function absoluteUrl(baseUrl, href) {
  try {
    return new URL(href, baseUrl).toString();
  } catch {
    return null;
  }
}

function inferCondition(title = "", context = "") {
  const rank = cleanText(context).match(/中古[：:]?\s*([A-Z][A-Z+-]*)/i)?.[0];
  if (rank) return cleanText(rank);
  return cleanText(title).match(/『([^』]+)』/)?.[1] || "";
}

function conditionForListing(options, title = "", context = "") {
  return options.fixedConditionText
    ? cleanText(options.fixedConditionText)
    : inferCondition(title, context);
}

function stockStatusForListing(options, priceYen, inferredStatus) {
  if (options.priceImpliesInStock && priceYen != null) return "in_stock";
  return inferredStatus;
}

function fromJsonLd(html, options) {
  const { baseUrl, hintedCategory } = options;
  const products = [];
  for (const root of decodeJsonLd(html)) {
    walkJson(root, (node) => {
      const type = Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]];
      if (!type.some((v) => String(v).toLowerCase() === "product")) return;
      const title = cleanText(node.name || "");
      const url = absoluteUrl(baseUrl, node.url || node["@id"] || "");
      if (!title || !url) return;
      const offer = Array.isArray(node.offers) ? node.offers[0] : node.offers || {};
      const priceYen = parseYen(String(offer.price ?? node.price ?? ""));
      const availability = String(offer.availability || "");
      const inferredStock = /outofstock|soldout/i.test(availability)
        ? "sold_out"
        : /instock/i.test(availability)
          ? "in_stock"
          : "unknown";
      const stockStatus = stockStatusForListing(options, priceYen, inferredStock);
      const { manufacturer, model } = splitManufacturerModel(title, options.shopKey);
      products.push({
        sourceId: stableSourceId(url, title),
        manufacturer,
        model,
        title,
        category: inferCategory(title, hintedCategory),
        conditionText: conditionForListing(options, title),
        priceYen,
        stockStatus,
        sourceUrl: url,
      });
    });
  }
  return products;
}

function stripTagsKeepingSpacing(html) {
  const withAttributes = html.replace(/<(?:img|input)\b([^>]*)>/gi, (_, attrs) => {
    const labels = [...attrs.matchAll(/\b(?:alt|title|aria-label)\s*=\s*["']([^"']+)["']/gi)].map(
      (match) => match[1],
    );
    return labels.length ? ` ${labels.join(" ")} ` : " ";
  });
  return cleanText(
    withAttributes
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<\/p>|<\/li>|<\/div>|<\/article>/gi, " "),
  );
}

function fromAnchors(html, options) {
  const { baseUrl, hintedCategory, productUrlPattern } = options;
  const products = [];
  const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  const anchors = [...html.matchAll(anchorRe)];

  for (const match of anchors) {
    const href = match[2];
    const url = absoluteUrl(baseUrl, href);
    if (!url || (productUrlPattern && !productUrlPattern.test(url))) continue;

    const index = match.index ?? 0;
    const before = html.slice(Math.max(0, index - 500), index);
    const after = html.slice(index, Math.min(html.length, index + match[0].length + 900));
    const context = stripTagsKeepingSpacing(`${before} ${match[4]} ${after}`);
    const anchorText = stripTagsKeepingSpacing(match[4]);
    const priceContext =
      options.priceContext === "forward"
        ? stripTagsKeepingSpacing(`${match[4]} ${after}`)
        : context;
    const priceYen = parseYen(priceContext);
    if (!priceYen) continue;

    let title = anchorText;
    if (!title || title.length < 3 || /詳細|more|商品を見る|画像/i.test(title)) {
      const candidates = context
        .split(/￥|¥|[0-9][0-9,]*円/)[0]
        .split(/\s{2,}|\|/)
        .map(cleanText)
        .filter((v) => v.length >= 4);
      title = candidates.at(-1) || "";
    }
    title = cleanText(title);
    if (!title || title.length > 220) continue;

    const condition = conditionForListing(options, title, context);
    const { manufacturer, model } = splitManufacturerModel(title, options.shopKey);
    products.push({
      sourceId: stableSourceId(url, title),
      manufacturer,
      model,
      title,
      category: inferCategory(title, hintedCategory),
      conditionText: condition,
      priceYen,
      stockStatus: stockStatusForListing(options, priceYen, inferStockStatus(context)),
      sourceUrl: url,
    });
  }
  return products;
}

function itemQuality(item) {
  return (
    (item.stockStatus !== "unknown" ? 500 : 0) +
    (item.model ? 200 : 0) +
    (item.priceYen != null ? 100 : 0) +
    Math.min(item.title?.length || 0, 180)
  );
}

function exactKnownManufacturer(value = "") {
  const raw = cleanText(value);
  if (!raw) return null;
  const normalized = normalizeManufacturer(raw);
  return normalized.matchedAlias ? { raw, ...normalized } : null;
}

function knownManufacturerCandidate(titles) {
  const exact = titles
    .map((title) => {
      const manufacturer = exactKnownManufacturer(title);
      return manufacturer ? { ...manufacturer, consumedTitles: new Set([title]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.raw.length - a.raw.length)[0];
  if (exact) return exact;

  const combined = [];
  const maxParts = Math.min(3, titles.length);
  for (let size = 2; size <= maxParts; size += 1) {
    for (let start = 0; start + size <= titles.length; start += 1) {
      const parts = titles.slice(start, start + size);
      const raw = parts.join(" ");
      const normalized = normalizeManufacturer(raw);
      if (!normalized.matchedAlias) continue;
      combined.push({ raw, ...normalized, consumedTitles: new Set(parts) });
    }
  }
  return combined.sort((a, b) => b.raw.length - a.raw.length)[0] || null;
}

function modelCandidate(text, manufacturer, shopKey) {
  const raw = cleanText(text);
  if (!raw || manufacturer.consumedTitles.has(raw)) return null;
  const exact = exactKnownManufacturer(raw);
  if (exact?.id === manufacturer.id) return null;

  const split = splitManufacturerModel(raw, shopKey);
  const splitManufacturer = normalizeManufacturer(split.manufacturer);
  const model = splitManufacturer.id === manufacturer.id && split.model ? split.model : raw;
  if (!model || exactKnownManufacturer(model)?.id === manufacturer.id) return null;

  let score = Math.min(raw.length, 180);
  if (/\d/.test(model)) score += 300;
  if (/[-+./]/.test(model)) score += 40;
  if (splitManufacturer.id === manufacturer.id && split.model) score += 100;
  return { raw, model: cleanText(model), score };
}

function modelAfterPrefix(detail, manufacturer) {
  const normalizedDetail = cleanText(detail);
  const normalizedManufacturer = cleanText(manufacturer);
  if (
    !normalizedDetail ||
    !normalizedManufacturer ||
    normalizedDetail.length <= normalizedManufacturer.length
  )
    return "";
  if (!normalizedDetail.toLowerCase().startsWith(normalizedManufacturer.toLowerCase())) return "";
  const boundary = normalizedDetail[normalizedManufacturer.length];
  if (boundary && !/[\s・･_\-/&+.,'"()（）]/.test(boundary)) return "";
  return normalizedDetail
    .slice(normalizedManufacturer.length)
    .replace(/^[\s・･_\-/&+.,'"()（）]+/, "")
    .trim();
}

function inferUnknownManufacturerAndModel(titles, shopKey) {
  const prefixPairs = [];
  for (const manufacturer of titles) {
    if (manufacturer.length > 80) continue;
    for (const detail of titles) {
      if (detail === manufacturer) continue;
      const model = modelAfterPrefix(detail, manufacturer);
      if (!model) continue;
      prefixPairs.push({
        manufacturer,
        model,
        score: manufacturer.length * 10 + model.length + (/\d/.test(model) ? 100 : 0),
      });
    }
  }
  if (prefixPairs.length) {
    return prefixPairs.sort((a, b) => b.score - a.score)[0];
  }

  const brandCandidates = titles.filter((title) => title.length <= 80 && !/\d/.test(title));
  const modelCandidates = titles
    .map((title) => {
      const split = splitManufacturerModel(title, shopKey);
      const score =
        (/\d/.test(title) ? 300 : 0) +
        (/[-+./]/.test(title) ? 40 : 0) +
        Math.min(title.length, 180);
      return { title, split, score };
    })
    .filter((candidate) => candidate.score >= 300)
    .sort((a, b) => b.score - a.score);

  if (brandCandidates.length !== 1 || !modelCandidates.length) return null;
  const manufacturer = brandCandidates[0];
  const bestModel = modelCandidates.find((candidate) => candidate.title !== manufacturer);
  if (!bestModel) return null;
  return { manufacturer, model: bestModel.title };
}

function mergeManufacturerModelCandidates(items, options) {
  const groups = new Map();
  for (const item of items) {
    if (!item.sourceId || !item.sourceUrl || !item.title) continue;
    if (!groups.has(item.sourceId)) groups.set(item.sourceId, []);
    groups.get(item.sourceId).push(item);
  }

  const result = [];
  for (const group of groups.values()) {
    const base = group.reduce(
      (best, item) => (itemQuality(item) > itemQuality(best) ? item : best),
      group[0],
    );
    const titles = [...new Set(group.map((item) => cleanText(item.title)).filter(Boolean))];
    const manufacturer = knownManufacturerCandidate(titles);

    if (manufacturer) {
      const model =
        titles
          .map((title) => modelCandidate(title, manufacturer, options.shopKey))
          .filter(Boolean)
          .sort((a, b) => b.score - a.score)[0]?.model || "";
      const combinedTitle = model ? `${manufacturer.raw} ${model}` : manufacturer.raw;
      result.push({
        ...base,
        manufacturer: manufacturer.raw,
        model,
        title: combinedTitle,
        category: inferCategory(combinedTitle, options.hintedCategory),
        conditionText: conditionForListing(options, combinedTitle),
        stockStatus:
          group.find((item) => item.stockStatus !== "unknown")?.stockStatus || base.stockStatus,
      });
      continue;
    }

    const inferred = inferUnknownManufacturerAndModel(titles, options.shopKey);
    if (inferred) {
      const combinedTitle = `${inferred.manufacturer} ${inferred.model}`;
      result.push({
        ...base,
        manufacturer: inferred.manufacturer,
        model: inferred.model,
        title: combinedTitle,
        category: inferCategory(combinedTitle, options.hintedCategory),
        conditionText: conditionForListing(options, combinedTitle),
        stockStatus:
          group.find((item) => item.stockStatus !== "unknown")?.stockStatus || base.stockStatus,
      });
      continue;
    }

    result.push({
      ...base,
      conditionText: conditionForListing(options, base.title),
    });
  }
  return result;
}

function deduplicateByQuality(items) {
  const unique = new Map();
  for (const item of items) {
    if (!item.sourceId || !item.sourceUrl || !item.title) continue;
    const existing = unique.get(item.sourceId);
    if (!existing || itemQuality(item) > itemQuality(existing)) unique.set(item.sourceId, item);
  }
  return [...unique.values()];
}

export function parseProductPage(html, options) {
  const candidates = [...fromJsonLd(html, options), ...fromAnchors(html, options)];
  if (options.identityStrategy === "manufacturer-model-candidates") {
    return mergeManufacturerModelCandidates(candidates, options);
  }
  return deduplicateByQuality(candidates);
}
