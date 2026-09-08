import { bootstrapManufacturers, normalizeManufacturerKey } from "./manufacturers.js";
import type { ManufacturerAliasEvidence } from "./types.js";

/** Shop controls override the same manufacturer's global spelling, never another brand's claim. */
export function aliasesForShop(rows: readonly ManufacturerAliasEvidence[], shopKey = "") {
  const local = rows.filter((row) => row.shopKey && row.shopKey === shopKey);
  const key = (row: ManufacturerAliasEvidence) =>
    `${row.manufacturerId}\u0000${normalizeManufacturerKey(row.normalizedAlias || row.alias)}`;
  const overridden = new Set(local.map(key));
  return [...local, ...rows.filter((row) => !row.shopKey && !overridden.has(key(row)))];
}

/** Only explicit admin rejection disables bundled evidence; historical rejected suggestions do not. */
export function effectiveManufacturerAliases(
  operational: readonly ManufacturerAliasEvidence[],
  ruleVersion: number,
): ManufacturerAliasEvidence[] {
  const key = (row: ManufacturerAliasEvidence) =>
    `${row.manufacturerId}\u0000${normalizeManufacturerKey(row.normalizedAlias || row.alias)}`;
  const disabled = new Set(
    operational
      .filter(
        (row) => row.source === "admin_alias_control" && row.verificationStatus === "rejected",
      )
      .map(key),
  );
  const names = new Map(operational.map((row) => [row.manufacturerId, row.canonicalName]));
  const bootstrap = bootstrapManufacturers().flatMap((manufacturer) =>
    [manufacturer.name, ...manufacturer.aliases].map((alias) => ({
      manufacturerId: manufacturer.id,
      canonicalName: names.get(manufacturer.id) || manufacturer.name,
      alias,
      normalizedAlias: normalizeManufacturerKey(alias),
      verificationStatus: "verified" as const,
      source: "code_bootstrap",
      ruleVersion,
    })),
  );
  const seen = new Set<string>();
  return [...operational, ...bootstrap]
    .map((row) => ({
      ...row,
      normalizedAlias: normalizeManufacturerKey(row.normalizedAlias || row.alias),
    }))
    .filter((row) => {
      const identity = `${key(row)}\u0000${row.verificationStatus}`;
      if (
        !row.normalizedAlias ||
        row.verificationStatus === "rejected" ||
        disabled.has(key(row)) ||
        seen.has(identity)
      )
        return false;
      seen.add(identity);
      return true;
    });
}

/** Prepare only the global dictionary initially; memoize dictionaries for shops actually processed. */
export function scopedAliasCache<T>(
  rows: readonly ManufacturerAliasEvidence[],
  prepare: (rows: readonly ManufacturerAliasEvidence[]) => T,
) {
  const global = prepare(aliasesForShop(rows));
  const scopedShops = new Set(rows.map((row) => row.shopKey).filter(Boolean));
  const cache = new Map<string, T>();
  return (shopKey = ""): T => {
    if (!scopedShops.has(shopKey)) return global;
    const cached = cache.get(shopKey);
    if (cached !== undefined) return cached;
    const result = prepare(aliasesForShop(rows, shopKey));
    cache.set(shopKey, result);
    return result;
  };
}
