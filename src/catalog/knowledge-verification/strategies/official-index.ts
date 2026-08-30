/**
 * Verifies a model from a manufacturer's own category or history index.
 *
 * These pages are the best evidence a used-audio catalog has for discontinued gear: they list
 * models the current-product site has dropped, under a heading that states the category.
 *
 * An index describes many products at once, so the page is not verified as a whole. The block that
 * mentions the model, its nearest preceding heading, and the following block are lifted into a
 * small synthetic document, and only that is classified — otherwise a turntable two rows down
 * would decide an amplifier's category.
 */

import { clean, escapeHtml, stripTags } from "../html.js";
import { containsFlexibleCatalogModelIdentity } from "../model-matching.js";
import { verifyOfficialProductPage } from "../page-verification.js";
import { StrategyAttempts } from "../pipeline.js";
import { aliasCandidate, lookupAliases, verifiedForOriginalCandidate } from "./alias-lookup.js";
import type { VerificationStrategy } from "../pipeline.js";
import type {
  FetchTextResult,
  KnowledgeSourceCandidate,
  KnowledgeSourceVerification,
} from "../types.js";

interface OfficialIndex {
  url: string;
  sourceType?: string;
  /** Stated only where the index itself is authoritative about the category. */
  categoryId?: string;
}

interface BlockEntry {
  tag: string;
  text: string;
}

/** Bounds the block scan so a huge index page cannot dominate one candidate's budget. */
const MAX_BLOCK_ENTRIES = 2_000;

/** How far back to look for the heading that a listing sits under. */
const MAX_HEADING_LOOKBACK = 20;

/** Keeps the synthetic document small enough to classify as one product. */
const MAX_CONTEXT_CHARS = 1400;

const OFFICIAL_INDEXES: Readonly<Record<string, readonly OfficialIndex[]>> = Object.freeze({
  accuphase: [
    { url: "https://www.accuphase.com/history", sourceType: "manufacturer_archive" },
    { url: "https://www.accuphase.com/cat/index.html", sourceType: "manufacturer_official" },
  ],
  denon: [
    // AVS-3 is listed beside AV receivers but is an HDMI switcher, so these pages intentionally
    // carry no category hint. Model-local official text decides the category instead.
    { url: "https://www.denon.com/ja-jp/category/av-receivers/" },
    {
      url: "https://www.denon.com/ja-jp/category/archive-av-receivers/",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/turntables/", categoryId: "ANA.TURNTABLE" },
    {
      url: "https://www.denon.com/category/archive-turntables/",
      categoryId: "ANA.TURNTABLE",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/turntable-cartridges/", categoryId: "ANA.CARTRIDGE" },
    {
      url: "https://www.denon.com/ja-jp/category/network-audio-players/",
      categoryId: "SRC.STREAMER",
    },
    {
      url: "https://www.denon.com/category/archive-network-audio-players/",
      categoryId: "SRC.STREAMER",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/sound-bars/", categoryId: "SPK.SOUNDBAR" },
    {
      url: "https://www.denon.com/category/archive-sound-bars/",
      categoryId: "SPK.SOUNDBAR",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/cd-players/", categoryId: "SRC.DISC" },
    {
      url: "https://www.denon.com/ja-jp/category/archive-cd-players/",
      categoryId: "SRC.DISC",
      sourceType: "manufacturer_archive",
    },
    {
      url: "https://www.denon.com/ja-jp/category/archive-amplifiers/",
      sourceType: "manufacturer_archive",
    },
    { url: "https://www.denon.com/ja-jp/category/perl/", categoryId: "PER.EARPHONE" },
    { url: "https://www.denon.com/ja-jp/category/all-audio-components/" },
  ],
  esoteric: [
    { url: "https://www.esoteric.jp/jp/support/discon", sourceType: "manufacturer_archive" },
    { url: "https://www.esoteric.jp/jp/support/download/", sourceType: "manufacturer_official" },
  ],
  luxman: [{ url: "https://www.luxman.co.jp/product/" }],
  yamaha: [
    {
      url: "https://jp.yamaha.com/products/contents/audio_visual/hifi_components/hifi-history/index.html",
      sourceType: "manufacturer_archive",
    },
  ],
});

const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  av_receiver: "AV Receiver",
  "ANA.CARTRIDGE": "Cartridge",
  "SRC.DISC": "CD/SACD Player",
  "PER.EARPHONE": "Earphones",
  "SRC.STREAMER": "Network Audio Player",
  "SPK.SOUNDBAR": "Soundbar",
  "ANA.TURNTABLE": "Turntable",
});

function blockEntries(html: string = ""): BlockEntry[] {
  const entries: BlockEntry[] = [];
  const pattern = /<(h[1-6]|tr|li|p|dt|dd|article|section)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  for (const match of String(html).matchAll(pattern)) {
    const text = stripTags(match[2]);
    if (text) entries.push({ tag: match[1].toLowerCase(), text });
    if (entries.length >= MAX_BLOCK_ENTRIES) break;
  }
  return entries;
}

/** The model's own row plus the heading it sits under; `""` when the index never mentions it. */
function contextForAlias(html: string, alias: string, categoryId = ""): string {
  const entries = blockEntries(html);
  for (let index = 0; index < entries.length; index += 1) {
    if (!containsFlexibleCatalogModelIdentity(entries[index].text, alias)) continue;
    let heading = "";
    for (let cursor = index - 1; cursor >= Math.max(0, index - MAX_HEADING_LOOKBACK); cursor -= 1) {
      if (/^h[1-6]$/.test(entries[cursor].tag)) {
        heading = entries[cursor].text;
        break;
      }
    }
    const next = entries[index + 1]?.text || "";
    const explicitCategory = categoryId ? `Category ${categoryId}` : "";
    return clean(
      [explicitCategory, heading, entries[index].text, next].filter(Boolean).join(" "),
    ).slice(0, MAX_CONTEXT_CHARS);
  }
  // Some indexes render their listing without block elements around each entry.
  const pageText = stripTags(html);
  if (containsFlexibleCatalogModelIdentity(pageText, alias)) {
    return clean(
      [categoryId ? `Category ${categoryId}` : "", pageText].filter(Boolean).join(" "),
    ).slice(0, MAX_CONTEXT_CHARS);
  }
  return "";
}

/** Presents the extracted context as a one-product page so the shared page verifier can read it. */
function syntheticHtml(alias: string, context: string, categoryId = ""): string {
  const category = CATEGORY_LABELS[categoryId] || "";
  const value = clean([category, alias, context].filter(Boolean).join(" "));
  return `<html><head><title>${escapeHtml(value)}</title></head><body><h1>${escapeHtml(value)}</h1></body></html>`;
}

export interface OfficialIndexStrategyOptions {
  fetchPage: (url: string) => Promise<FetchTextResult>;
}

export function createOfficialIndexStrategy({
  fetchPage,
}: OfficialIndexStrategyOptions): VerificationStrategy {
  async function verifyAliasOnIndex(
    candidate: KnowledgeSourceCandidate,
    alias: string,
    page: FetchTextResult,
    index: OfficialIndex,
  ): Promise<KnowledgeSourceVerification | null> {
    const context = contextForAlias(page.text, alias, index.categoryId || "");
    if (!context) return null;
    const result = await verifyOfficialProductPage({
      candidate: aliasCandidate(candidate, alias),
      html: syntheticHtml(alias, context, index.categoryId || ""),
      sourceUrl: page.url,
      sourceType: index.sourceType || "manufacturer_official",
      httpStatus: page.status,
    });
    return verifiedForOriginalCandidate(result, candidate);
  }

  return {
    name: "official_index",
    async verify(candidate: KnowledgeSourceCandidate): Promise<KnowledgeSourceVerification | null> {
      const manufacturerId = String(candidate?.manufacturerId || "").toLowerCase();
      const indexes = OFFICIAL_INDEXES[manufacturerId];
      if (!indexes?.length) return null;

      const aliases = lookupAliases(candidate);
      const attempts = new StrategyAttempts();
      for (const index of indexes) {
        const page = await fetchPage(index.url);
        if (!page.ok) continue;
        for (const alias of aliases) {
          const verified = attempts.record(await verifyAliasOnIndex(candidate, alias, page, index));
          if (verified) return verified;
        }
      }
      return attempts.best();
    },
  };
}
