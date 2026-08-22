import {
  bootstrapManufacturers,
  isManufacturerPlaceholder,
  manufacturerPrefixPattern,
  normalizeManufacturerKey,
} from "./manufacturers.js";
import type {
  ManufacturerAliasEvidence,
  ManufacturerResolutionInput,
  ManufacturerResolutionMethod,
  ManufacturerResolutionResult,
  NormalizedCatalogProduct,
} from "./types.js";

export const MANUFACTURER_RESOLVER_VERSION = 7;

export type ManufacturerResolver = (
  input: ManufacturerResolutionInput,
) => ManufacturerResolutionResult;

interface PreparedManufacturerAliases {
  exact: ReadonlyMap<string, ManufacturerAliasEvidence[]>;
  prefixes: readonly {
    row: ManufacturerAliasEvidence;
    pattern: RegExp;
  }[];
}

function clean(value: unknown = ""): string {
  return String(value).normalize("NFKC").replace(/\s+/g, " ").trim();
}

function bootstrapAliases(): ManufacturerAliasEvidence[] {
  return bootstrapManufacturers().flatMap((manufacturer) =>
    [manufacturer.name, ...manufacturer.aliases].map((alias) => ({
      manufacturerId: manufacturer.id,
      canonicalName: manufacturer.name,
      alias,
      normalizedAlias: normalizeManufacturerKey(alias),
      verificationStatus: "verified" as const,
      source: "code_bootstrap",
      ruleVersion: MANUFACTURER_RESOLVER_VERSION,
    })),
  );
}

function allAliases(operationalAliases: readonly ManufacturerAliasEvidence[]) {
  const rows = [...operationalAliases, ...bootstrapAliases()]
    .map((row) => ({
      ...row,
      normalizedAlias: normalizeManufacturerKey(row.normalizedAlias || row.alias),
    }))
    .filter((row) => row.normalizedAlias && row.verificationStatus !== "rejected");
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.manufacturerId}\u0000${row.normalizedAlias}\u0000${row.verificationStatus}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prepareAliases(
  operationalAliases: readonly ManufacturerAliasEvidence[],
): PreparedManufacturerAliases {
  const exact = new Map<string, ManufacturerAliasEvidence[]>();
  const prefixes: { row: ManufacturerAliasEvidence; pattern: RegExp }[] = [];
  for (const row of allAliases(operationalAliases)) {
    const matches = exact.get(row.normalizedAlias) || [];
    matches.push(row);
    exact.set(row.normalizedAlias, matches);
    const pattern = manufacturerPrefixPattern(row.alias);
    if (pattern) prefixes.push({ row, pattern });
  }
  return { exact, prefixes };
}

function candidateResult(
  raw: string,
  normalizedRaw: string,
  method: Extract<ManufacturerResolutionMethod, "ambiguous_alias" | "unverified_alias">,
  manufacturerIds: readonly string[],
): ManufacturerResolutionResult {
  return {
    canonicalManufacturerId: "",
    displayName: raw,
    normalizedRawManufacturer: normalizedRaw,
    status: "candidate",
    method,
    confidence: "low",
    matchedAlias: false,
    candidateManufacturerIds: [...new Set(manufacturerIds)].sort(),
  };
}

function resolveAliasRows(
  raw: string,
  normalizedRaw: string,
  rows: readonly ManufacturerAliasEvidence[],
  titleEvidence: boolean,
): ManufacturerResolutionResult | null {
  const verifiedIds = [
    ...new Set(
      rows.filter((row) => row.verificationStatus === "verified").map((row) => row.manufacturerId),
    ),
  ].sort();
  if (verifiedIds.length > 1) {
    return candidateResult(raw, normalizedRaw, "ambiguous_alias", verifiedIds);
  }
  if (verifiedIds.length === 1) {
    const manufacturerId = verifiedIds[0];
    const matching = rows.filter(
      (row) => row.verificationStatus === "verified" && row.manufacturerId === manufacturerId,
    );
    const operational = matching.some((row) => row.source !== "code_bootstrap");
    const method: ManufacturerResolutionMethod = titleEvidence
      ? operational
        ? "title_verified_alias"
        : "title_bootstrap_alias"
      : operational
        ? "verified_alias"
        : "bootstrap_alias";
    return {
      canonicalManufacturerId: manufacturerId,
      displayName: matching[0]?.canonicalName || raw,
      normalizedRawManufacturer: normalizedRaw,
      status: "resolved",
      method,
      confidence: "high",
      matchedAlias: true,
      candidateManufacturerIds: [],
    };
  }

  const pendingIds = [
    ...new Set(
      rows.filter((row) => row.verificationStatus === "pending").map((row) => row.manufacturerId),
    ),
  ];
  return pendingIds.length
    ? candidateResult(raw, normalizedRaw, "unverified_alias", pendingIds)
    : null;
}

/**
 * Recover a legacy parser artifact where an unknown multi-word brand was truncated to its first
 * token (for example `Silent` from `Silent Angel`). The full verified alias must be present at the
 * start of the title, and the explicit seller value must itself be a complete token-prefix of that
 * alias. Arbitrary unknown manufacturer text therefore still cannot be overridden by the title.
 */
function resolveTruncatedManufacturerPrefix(
  raw: string,
  normalizedRaw: string,
  candidate: string,
  title: unknown,
  aliases: PreparedManufacturerAliases,
): ManufacturerResolutionResult | null {
  const explicitValues = [...new Set([raw, candidate].map(clean).filter(Boolean))];
  if (!explicitValues.length) return null;

  const cleanTitle = clean(title);
  const compatible = aliases.prefixes.filter((entry) => {
    if (!entry.pattern.test(cleanTitle)) return false;
    return explicitValues.some((value) => {
      const valueKey = normalizeManufacturerKey(value);
      if (valueKey.length < 2 || valueKey === entry.row.normalizedAlias) return false;
      const prefixPattern = manufacturerPrefixPattern(value);
      return Boolean(prefixPattern?.test(clean(entry.row.alias)));
    });
  });
  const longest = Math.max(0, ...compatible.map((entry) => entry.row.normalizedAlias.length));
  if (!longest) return null;
  const strongest = compatible
    .filter((entry) => entry.row.normalizedAlias.length === longest)
    .map((entry) => entry.row);
  return resolveAliasRows(raw || candidate, normalizedRaw, strongest, true);
}

function resolvePreparedManufacturer(
  { rawManufacturer, manufacturerCandidate, title }: ManufacturerResolutionInput,
  aliases: PreparedManufacturerAliases,
): ManufacturerResolutionResult {
  const raw = clean(rawManufacturer);
  const candidate = clean(manufacturerCandidate);
  if (isManufacturerPlaceholder(raw) || isManufacturerPlaceholder(candidate)) {
    return {
      canonicalManufacturerId: "",
      displayName: "",
      normalizedRawManufacturer: "",
      status: "unresolved",
      method: "none",
      confidence: "none",
      matchedAlias: false,
      candidateManufacturerIds: [],
    };
  }
  const normalizedRaw = normalizeManufacturerKey(raw);
  const normalizedCandidate = normalizeManufacturerKey(candidate);

  if (normalizedRaw) {
    const exactRaw = aliases.exact.get(normalizedRaw) || [];
    const rawResult = resolveAliasRows(raw, normalizedRaw, exactRaw, false);
    if (rawResult) return rawResult;
  }
  if (normalizedCandidate && normalizedCandidate !== normalizedRaw) {
    const exactCandidate = aliases.exact.get(normalizedCandidate) || [];
    const candidateResult = resolveAliasRows(candidate, normalizedRaw, exactCandidate, false);
    if (candidateResult) return candidateResult;
  }
  if (normalizedRaw || normalizedCandidate) {
    const recovered = resolveTruncatedManufacturerPrefix(
      raw,
      normalizedRaw,
      candidate,
      title || "",
      aliases,
    );
    if (recovered) return recovered;
    return {
      canonicalManufacturerId: "",
      displayName: candidate || raw,
      normalizedRawManufacturer: normalizedRaw,
      status: "unresolved",
      method: "none",
      confidence: "none",
      matchedAlias: false,
      candidateManufacturerIds: [],
    };
  }

  const cleanTitle = clean(title);
  const prefixMatches = aliases.prefixes.filter((entry) => entry.pattern.test(cleanTitle));
  const longest = Math.max(0, ...prefixMatches.map((entry) => entry.row.normalizedAlias.length));
  const strongest = prefixMatches
    .filter((entry) => entry.row.normalizedAlias.length === longest)
    .map((entry) => entry.row);
  const titleResult = resolveAliasRows("", "", strongest, true);
  if (titleResult) return titleResult;

  return {
    canonicalManufacturerId: "",
    displayName: "",
    normalizedRawManufacturer: "",
    status: "unresolved",
    method: "none",
    confidence: "none",
    matchedAlias: false,
    candidateManufacturerIds: [],
  };
}

/** Compile one alias snapshot for bounded batch resolution without repeated D1 reads or regexes. */
export function createManufacturerResolver(
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ManufacturerResolver {
  const aliases = prepareAliases(operationalAliases);
  return (input) => resolvePreparedManufacturer(input, aliases);
}

/** Pure, deterministic one-off resolution over bootstrap plus D1-provided alias evidence. */
export function resolveManufacturer(
  input: ManufacturerResolutionInput,
  operationalAliases: readonly ManufacturerAliasEvidence[] = [],
): ManufacturerResolutionResult {
  return createManufacturerResolver(operationalAliases)(input);
}

/** Re-resolve an already parsed listing without touching its immutable seller evidence. */
export function applyManufacturerResolution(
  product: NormalizedCatalogProduct,
  aliasesOrResolver: readonly ManufacturerAliasEvidence[] | ManufacturerResolver = [],
): NormalizedCatalogProduct {
  const resolver =
    typeof aliasesOrResolver === "function"
      ? aliasesOrResolver
      : createManufacturerResolver(aliasesOrResolver);
  const resolution = resolver({
    rawManufacturer: product.rawManufacturer,
    manufacturerCandidate: product.rawManufacturer ? product.manufacturer : "",
    title: product.title,
  });
  return {
    ...product,
    manufacturer: resolution.displayName || product.manufacturer,
    manufacturerId: resolution.canonicalManufacturerId,
    normalizedRawManufacturer: resolution.normalizedRawManufacturer,
    manufacturerResolutionStatus: resolution.status,
    manufacturerResolutionMethod: resolution.method,
    manufacturerResolutionConfidence: resolution.confidence,
    metadata: {
      ...product.metadata,
      manufacturerNormalization: {
        version: MANUFACTURER_RESOLVER_VERSION,
        matchedAlias: resolution.matchedAlias,
        status: resolution.status,
        method: resolution.method,
        confidence: resolution.confidence,
        normalizedRawManufacturer: resolution.normalizedRawManufacturer,
        candidateManufacturerIds: resolution.candidateManufacturerIds,
      },
    },
  };
}
