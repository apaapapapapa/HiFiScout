import {
  MANUFACTURER_SOURCE,
  manufacturerPrefixPattern,
  stripManufacturerListingLabels,
} from "../api/manufacturer-search-contracts.js";
export {
  manufacturerPrefixPattern,
  stripManufacturerListingLabels,
} from "../api/manufacturer-search-contracts.js";
import type {
  ManufacturerDefinition,
  ManufacturerModelSplit,
  ManufacturerNormalizationResult,
  PrefixAliasEntry,
} from "./types.js";

const MANUFACTURERS: readonly ManufacturerDefinition[] = MANUFACTURER_SOURCE.map(
  ([id, name, aliases]) => Object.freeze({ id, name, aliases }),
);

/** Numeric speaker-model tokens accidentally split into the brand column (for example 702S2). */
export function isModelOnlyManufacturer(value: unknown = ""): boolean {
  return /^\d{3,}[a-z]{1,2}\d*$/iu.test(stripManufacturerListingLabels(value).normalize("NFKC"));
}

const MANUFACTURER_PLACEHOLDER_RE = /^(?:不明(?:\s+.*)?|メーカー不明|その他|ノーブランド)$/u;

export function isManufacturerPlaceholder(value: unknown = ""): boolean {
  const text = stripManufacturerListingLabels(String(value))
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim();
  return MANUFACTURER_PLACEHOLDER_RE.test(text);
}

export function normalizeManufacturerKey(value: unknown = ""): string {
  const stripped = stripManufacturerListingLabels(String(value).normalize("NFKC"));
  if (isManufacturerPlaceholder(stripped) || isModelOnlyManufacturer(stripped)) return "";
  return stripped
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, "")
    .replace(/(?:株式会社|有限会社|合同会社)/g, "")
    .replace(/[\s・･_\-/&+.,'"()（）]+/g, "");
}

function cleanSourceText(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

const BY_ALIAS = new Map<string, ManufacturerDefinition>();
const BY_ID = new Map<string, ManufacturerDefinition>();
const PREFIX_ALIASES: PrefixAliasEntry[] = [];
for (const manufacturer of MANUFACTURERS) {
  BY_ID.set(manufacturer.id, manufacturer);
  const aliases = [manufacturer.name, ...manufacturer.aliases];
  for (const alias of aliases) {
    const key = normalizeManufacturerKey(alias);
    BY_ALIAS.set(key, manufacturer);
    const pattern = manufacturerPrefixPattern(alias);
    if (pattern) PREFIX_ALIASES.push({ manufacturer, alias, key, pattern });
  }
}
PREFIX_ALIASES.sort((a, b) => b.key.length - a.key.length || b.alias.length - a.alias.length);

// Most seller titles begin with an ASCII brand. Match only aliases with that initial rather than
// running every bootstrap regular expression for every listing. Keep the full path for other
// scripts so Unicode case-folding semantics stay owned by the existing /iu patterns.
const PREFIX_ALIASES_BY_INITIAL = new Map<string, PrefixAliasEntry[]>();
for (const candidate of PREFIX_ALIASES) {
  const initial = cleanSourceText(candidate.alias)
    .replace(/^[\s・･_\-/&+.,'"()（）]+/u, "")[0]
    ?.toLowerCase();
  if (!initial || !/^[a-z]$/u.test(initial)) continue;
  const entries = PREFIX_ALIASES_BY_INITIAL.get(initial) || [];
  entries.push(candidate);
  PREFIX_ALIASES_BY_INITIAL.set(initial, entries);
}

function hashKey(value: string): string {
  let hash = 0x811c9dc5;
  for (const char of value) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fallbackId(key: string): string {
  if (!key) return "";
  const ascii = key.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return ascii.length >= 2 ? ascii.slice(0, 80) : `brand-${hashKey(key)}`;
}

/**
 * Reproduce the pre-listing-label normalization key for legacy ids that can still exist while a
 * resolver-version replay is draining. This is deliberately private: new writes must always use
 * the current canonical normalization above.
 */
function legacyManufacturerKey(value: unknown = ""): string {
  return String(value)
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\b(?:co\.?\s*,?\s*ltd\.?|corporation|corp\.?|inc\.?|limited|ltd\.?)\b/gi, "")
    .replace(/(?:株式会社|有限会社|合同会社)/g, "")
    .replace(/[\s・･_\-/&+.,'"()（）]+/g, "");
}

export function manufacturerIdForFilter(value: unknown = ""): string {
  const raw = cleanSourceText(value).toLowerCase();
  if (BY_ID.has(raw)) return raw;
  const key = normalizeManufacturerKey(value);
  if (!key) return "";
  return BY_ALIAS.get(key)?.id || fallbackId(key);
}

/**
 * IDs that may represent the same known manufacturer while historical resolver output is being
 * replayed. The canonical id is first; the remaining ids are exactly the fallback ids the previous
 * normalization produced for canonical names and aliases (for example `msb` before
 * `msb-technology`). Unknown manufacturers keep their single deterministic id.
 */
export function manufacturerFilterIds(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) {
    const id = manufacturerIdForFilter(value);
    return id ? [id] : [];
  }

  const ids = new Set<string>([manufacturer.id]);
  for (const alias of [manufacturer.name, ...manufacturer.aliases]) {
    const legacyKey = legacyManufacturerKey(alias);
    if (legacyKey) ids.add(fallbackId(legacyKey));
  }
  return [...ids];
}

/** Public and seller spellings that may appear in a stale entity's manufacturer presentation. */
export function manufacturerFilterPresentations(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) {
    const presentation = cleanSourceText(stripManufacturerListingLabels(value));
    return presentation ? [presentation] : [];
  }
  return [...new Set([manufacturer.name, ...manufacturer.aliases])];
}

export function manufacturerSearchAliases(value: unknown = ""): string[] {
  const raw = cleanSourceText(value).toLowerCase();
  const manufacturer = BY_ID.get(raw) || BY_ALIAS.get(normalizeManufacturerKey(value));
  if (!manufacturer) return cleanSourceText(value) ? [cleanSourceText(value)] : [];
  return [...new Set([manufacturer.id, manufacturer.name, ...manufacturer.aliases])];
}

export function normalizeManufacturer(value: unknown = ""): ManufacturerNormalizationResult {
  const raw = cleanSourceText(stripManufacturerListingLabels(value));
  if (!raw) return { id: "", displayName: "", matchedAlias: false };
  const key = normalizeManufacturerKey(raw);
  if (!key) return { id: "", displayName: "", matchedAlias: false };
  const known = BY_ALIAS.get(key) || BY_ID.get(raw.toLowerCase());
  if (known) return { id: known.id, displayName: known.name, matchedAlias: true };
  return { id: fallbackId(key), displayName: raw, matchedAlias: false };
}

const BRACKETED_PREFIX = /^\s*[([［（【]\s*([^)\]］）】]{1,40})\s*[)\]］）】]/u;

/**
 * Remove a bracketed second spelling of the manufacturer that already matched as a prefix.
 *
 * Retailers write both spellings of one brand — `Bowers&Wilkins(B&W) 802D4 B`. Stripping the
 * bracketed alias as a whole group is what keeps the leading-separator cleanup below from eating
 * the opening bracket alone and stranding its closing bracket at the head of the model.
 */
export function stripBracketedManufacturerAlias(
  value: unknown = "",
  aliases: readonly string[] = [],
): string {
  const text = String(value);
  const match = text.match(BRACKETED_PREFIX);
  if (!match) return text;
  const key = normalizeManufacturerKey(match[1]);
  if (!key) return text;
  return aliases.some((alias) => normalizeManufacturerKey(alias) === key)
    ? text.slice(match[0].length)
    : text;
}

export function splitKnownManufacturerModel(value: unknown = ""): ManufacturerModelSplit | null {
  const raw = cleanSourceText(stripManufacturerListingLabels(value));
  if (!raw) return null;

  const initial = raw[0].toLowerCase();
  const candidates = /^[a-z]$/u.test(initial)
    ? PREFIX_ALIASES_BY_INITIAL.get(initial) || []
    : PREFIX_ALIASES;
  for (const candidate of candidates) {
    const match = raw.match(candidate.pattern);
    if (!match) continue;
    // TakeT's official TAKET-WS model starts with the complete brand spelling. Treating the
    // hyphen as an ordinary manufacturer boundary would truncate the model to `WS` before the
    // model resolver can preserve it.
    if (candidate.manufacturer.id === "taket" && /^TAKET-WS(?:$|[\s([（［])/iu.test(raw)) {
      return {
        id: candidate.manufacturer.id,
        displayName: candidate.manufacturer.name,
        rawManufacturer: match[0].trim(),
        model: raw,
      };
    }
    const model = stripBracketedManufacturerAlias(raw.slice(match[0].length), [
      candidate.manufacturer.name,
      ...candidate.manufacturer.aliases,
    ])
      .replace(/^[\s・･_\-/&+.,'"()（）]+/, "")
      .trim();
    return {
      id: candidate.manufacturer.id,
      displayName: candidate.manufacturer.name,
      rawManufacturer: match[0].trim(),
      model,
    };
  }
  return null;
}

/** Immutable bootstrap catalog used when D1 has no operational alias for a spelling yet. */
export function bootstrapManufacturers(): readonly ManufacturerDefinition[] {
  return MANUFACTURERS;
}
