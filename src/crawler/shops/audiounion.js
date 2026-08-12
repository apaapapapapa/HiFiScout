import { normalizeManufacturer } from "../../catalog/manufacturers.js";
import { cleanText, inferCategory, splitManufacturerModel, stableSourceId } from "../normalize.js";
import { parseProductPage } from "../parser.js";

const DEFAULT_ENTRY_URL = "https://www.audiounion.jp/st/new_arrival_used.html";
const DETAIL_URL_PATTERN = /audiounion\.jp\/ct\/detail\/used\/\d+\/?/i;
const BRAND_SUFFIXES = new Set([
  "audio",
  "acoustics",
  "acoustic",
  "audio labs",
  "labs",
  "lab",
  "design",
  "designs",
  "electronics",
  "technology",
  "technologies",
  "digital",
  "research",
  "engineering",
]);
const PRODUCT_TYPE_PREFIX =
  /^(?:スピーカー(?:システム)?|プリメインアンプ|プリアンプ|パワーアンプ|アンプ|cd\/?sacd(?:プレーヤー)?|sacd(?:プレーヤー)?|cd(?:プレーヤー)?|dac|d\/aコンバーター?|ネットワーク(?:プレーヤー)?|ターンテーブル|レコードプレーヤー|カートリッジ|ヘッドホン|イヤホン)\s*/i;
const SALES_NOISE = /(?:販売店|販売価格|税込価格|価格|商品コード|在庫)[：:]?/i;

function stripTagsKeepingSpacing(html) {
  return cleanText(
    String(html || "")
      .replace(/<(?:img|input)\b([^>]*)>/gi, (_, attrs) => {
        const labels = [
          ...attrs.matchAll(/\b(?:alt|title|aria-label)\s*=\s*["']([^"']+)["']/gi),
        ].map((match) => match[1]);
        return labels.length ? ` ${labels.join(" ")} ` : " ";
      })
      .replace(/<br\s*\/?\s*>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  );
}

function candidateText(value) {
  let text = cleanText(value)
    .replace(/^中古\s*/i, "")
    .replace(/^NEW\s*/i, "")
    .trim();
  const noise = text.search(SALES_NOISE);
  if (noise >= 0) text = text.slice(0, noise).trim();
  return text;
}

function detailLinkCandidates(html, baseUrl) {
  const groups = new Map();
  const anchorRe = /<a\b([^>]*?)href\s*=\s*["']([^"']+)["']([^>]*)>([\s\S]*?)<\/a>/gi;
  for (const match of String(html || "").matchAll(anchorRe)) {
    let url;
    try {
      url = new URL(match[2], baseUrl).toString();
    } catch {
      continue;
    }
    if (!DETAIL_URL_PATTERN.test(url)) continue;
    const sourceId = stableSourceId(url);
    const text = candidateText(stripTagsKeepingSpacing(match[4]));
    if (!sourceId || !text || /^(?:詳細|商品を見る|画像|中古|NEW)$/i.test(text)) continue;
    if (!groups.has(sourceId)) groups.set(sourceId, []);
    const values = groups.get(sourceId);
    if (!values.includes(text)) values.push(text);
  }
  return groups;
}

function exactKnownManufacturer(text) {
  const normalized = normalizeManufacturer(text);
  return normalized.matchedAlias ? normalized : null;
}

function combineKnownManufacturer(candidates) {
  for (let size = Math.min(3, candidates.length); size >= 1; size -= 1) {
    for (let start = 0; start + size <= candidates.length; start += 1) {
      const raw = candidates.slice(start, start + size).join(" ");
      if (exactKnownManufacturer(raw))
        return { raw, consumed: new Set(candidates.slice(start, start + size)) };
    }
  }
  return null;
}

function startsWithIdentityPrefix(detail, manufacturer) {
  const value = candidateText(detail);
  const prefix = cleanText(manufacturer);
  if (!value || !prefix) return "";
  const withoutCondition = value.replace(/^中古\s*/i, "").trim();
  if (!withoutCondition.toLowerCase().startsWith(prefix.toLowerCase())) return "";
  const boundary = withoutCondition[prefix.length];
  if (boundary && !/[\s・･_\-\/&+.,'"()（）]/.test(boundary)) return "";
  return withoutCondition
    .slice(prefix.length)
    .replace(/^[\s・･_\-\/&+.,'"()（）]+/, "")
    .trim();
}

function cleanModel(value) {
  let model = candidateText(value).replace(PRODUCT_TYPE_PREFIX, "").trim();
  const parts = model.split(/\s+/).filter(Boolean);
  if (parts.length === 2 && parts[0].toLowerCase() === parts[1].toLowerCase()) model = parts[0];
  return model;
}

function bestModel(candidates, manufacturer, consumed = new Set()) {
  const models = [];
  for (const candidate of candidates) {
    if (consumed.has(candidate) || candidate === manufacturer) continue;
    const prefixed = startsWithIdentityPrefix(candidate, manufacturer);
    const model = cleanModel(prefixed || candidate);
    if (!model || exactKnownManufacturer(model)) continue;
    let score = Math.min(model.length, 160);
    if (prefixed) score += 250;
    if (/\d/.test(model)) score += 300;
    if (/[-+./]/.test(model)) score += 40;
    if (model.length > 90) score -= 300;
    models.push({ model, score });
  }
  return models.sort((a, b) => b.score - a.score)[0]?.model || "";
}

function prefixPairIdentity(candidates) {
  const brandLike = candidates.filter((value) => value.length <= 80 && !/\d/.test(value));
  for (const manufacturer of brandLike) {
    for (const detail of candidates) {
      if (detail === manufacturer) continue;
      const remainder = startsWithIdentityPrefix(detail, manufacturer);
      if (!remainder) continue;
      const model = cleanModel(remainder);
      if (model) return { manufacturer, model };
    }
  }
  return null;
}

function suffixBrandIdentity(candidates) {
  if (candidates.length < 2) return null;
  for (let start = 0; start < candidates.length - 1; start += 1) {
    const first = candidates[start];
    const second = candidates[start + 1];
    if (/\d/.test(first) || /\d/.test(second)) continue;
    if (!BRAND_SUFFIXES.has(second.toLowerCase())) continue;
    const manufacturer = `${first} ${second}`;
    const consumed = new Set([first, second]);
    const model = bestModel(candidates, manufacturer, consumed);
    return { manufacturer, model };
  }
  return null;
}

function repairIdentity(item, candidates) {
  if (!candidates?.length) return item;

  const known = combineKnownManufacturer(candidates);
  if (known) {
    const model = bestModel(candidates, known.raw, known.consumed) || item.model;
    const title = model ? `${known.raw} ${model}` : known.raw;
    return {
      ...item,
      manufacturer: known.raw,
      model,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const prefixPair = prefixPairIdentity(candidates);
  if (prefixPair) {
    const title = `${prefixPair.manufacturer} ${prefixPair.model}`.trim();
    return {
      ...item,
      ...prefixPair,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const suffixBrand = suffixBrandIdentity(candidates);
  if (suffixBrand) {
    const title = suffixBrand.model
      ? `${suffixBrand.manufacturer} ${suffixBrand.model}`
      : suffixBrand.manufacturer;
    return {
      ...item,
      ...suffixBrand,
      title,
      category: inferCategory(title, item.category === "その他" ? "" : item.category),
    };
  }

  const cleanTitle = candidateText(item.title);
  if (cleanTitle !== item.title) {
    const split = splitManufacturerModel(cleanTitle, "audiounion");
    return {
      ...item,
      ...split,
      title: cleanTitle,
      category: inferCategory(cleanTitle, item.category === "その他" ? "" : item.category),
    };
  }
  return item;
}

function parseAudioUnion(html, pageUrl) {
  const fallback = parseProductPage(html, {
    shopKey: "audiounion",
    baseUrl: pageUrl,
    productUrlPattern: DETAIL_URL_PATTERN,
    priceContext: "forward",
    priceImpliesInStock: true,
    fixedConditionText: "中古",
    identityStrategy: "manufacturer-model-candidates",
  });
  const candidates = detailLinkCandidates(html, pageUrl);
  return fallback.map((item) => repairIdentity(item, candidates.get(item.sourceId)));
}

export const audioUnionAdapter = {
  key: "audiounion",
  name: "Audio Union",
  baseUrl: "https://www.audiounion.jp",
  transport: "relay",
  requestDelayMs: 10_000,
  *pageUrls(_maxPages, env) {
    yield env?.AUDIOUNION_ENTRY_URL?.trim() || DEFAULT_ENTRY_URL;
  },
  parse(html, pageUrl) {
    return parseAudioUnion(html, pageUrl);
  },
};
