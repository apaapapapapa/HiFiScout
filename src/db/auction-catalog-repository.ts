import { normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { resolveManufacturer } from "../catalog/manufacturer-resolver.js";
import { resolveModel } from "../catalog/model-resolver.js";
import { identitySafeModelLookupVariants } from "../catalog/knowledge-catalog.js";
import { catalogRetrievalKey, catalogRetrievalKeySql } from "./catalog-lookup-candidates.js";
import type { ManufacturerAliasEvidence } from "../catalog/types.js";
import type { QueryableDatabase } from "./types.js";
import { AUCTION_CATALOG_RULE } from "../auctions/catalog.js";
import type { AuctionCatalogEntry, AuctionCatalogInput } from "../auctions/catalog.js";

/** Read-only bounded snapshots; never inserts auction listings or unverified catalog candidates. */
export async function readAuctionCatalog(
  db: QueryableDatabase,
  inputs: readonly AuctionCatalogInput[],
): Promise<AuctionCatalogEntry[]> {
  const unique = [...new Map(inputs.map((input) => [input.key, input])).values()];
  if (
    unique.length > 20 ||
    unique.some((input) => input.manufacturer.length > 1000 || input.model.length > 1000)
  )
    throw new Error("auction_catalog_input_limit");
  if (!unique.length) return [];
  const clock = () =>
    db
      .prepare("SELECT generation,version FROM admin_manufacturer_registry_clock WHERE id=1")
      .all<{ generation: string; version: number }>();
  const before = await clock();
  const keys = [
    ...new Set(unique.map((input) => normalizeManufacturerKey(input.manufacturer)).filter(Boolean)),
  ];
  const aliases = await db
    .prepare(`SELECT a.manufacturer_id,a.alias,a.normalized_alias,a.verification_status,a.source,a.rule_version,m.canonical_name
    FROM json_each(?) wanted CROSS JOIN knowledge_catalog_manufacturer_aliases a INDEXED BY idx_knowledge_catalog_manufacturer_alias_lookup
    ON a.normalized_alias=wanted.value JOIN knowledge_catalog_manufacturers m ON m.id=a.manufacturer_id
    WHERE m.verification_status='verified' AND (a.verification_status IN ('pending','verified') OR a.source='admin_alias_control')
    ORDER BY a.normalized_alias,a.manufacturer_id,a.id LIMIT 257`)
    .bind(JSON.stringify(keys))
    .all<{
      manufacturer_id: string;
      alias: string;
      normalized_alias: string;
      verification_status: "verified" | "pending" | "rejected";
      source: string;
      rule_version: number;
      canonical_name: string;
    }>();
  if (aliases.results.length > 256) throw new Error("auction_catalog_alias_limit");
  const evidence: ManufacturerAliasEvidence[] = aliases.results.map((row) => ({
    manufacturerId: row.manufacturer_id,
    canonicalName: row.canonical_name,
    alias: row.alias,
    normalizedAlias: row.normalized_alias,
    verificationStatus: row.verification_status,
    source: row.source,
    ruleVersion: row.rule_version,
  }));
  const normalized = unique.map((input) => {
    const manufacturer = resolveManufacturer({ rawManufacturer: input.manufacturer }, evidence);
    const model = resolveModel(
      {
        rawManufacturer: input.manufacturer,
        rawModel: input.model,
        manufacturerId: manufacturer.canonicalManufacturerId,
      },
      evidence,
    );
    return { input, manufacturer, model };
  });
  const wanted = normalized.flatMap(({ input, manufacturer, model }) =>
    manufacturer.status === "resolved" && model.status === "resolved"
      ? [
          ...new Set(
            identitySafeModelLookupVariants({
              manufacturerId: manufacturer.canonicalManufacturerId,
              model: model.model,
            }).map(catalogRetrievalKey),
          ),
        ]
          .slice(0, 8)
          .map((key) => [input.key, manufacturer.canonicalManufacturerId, key])
      : [],
  );
  const lookupJson = JSON.stringify(wanted);
  const lookups = wanted.length
    ? await db.batch<{ id: number; input_key: string }>([
        db
          .prepare(`SELECT kp.id,json_extract(w.value,'$[0]') input_key FROM json_each(?) w
      CROSS JOIN knowledge_catalog_products kp INDEXED BY idx_catalog_products_retrieval_key
      WHERE kp.verification_status='verified' AND kp.manufacturer_id=json_extract(w.value,'$[1]')
      AND ${catalogRetrievalKeySql("kp.normalized_model")} = json_extract(w.value,'$[2]') LIMIT 65`)
          .bind(lookupJson),
        db
          .prepare(`SELECT kp.id,json_extract(w.value,'$[0]') input_key FROM json_each(?) w
      CROSS JOIN knowledge_catalog_aliases ka INDEXED BY idx_catalog_aliases_retrieval_key
      CROSS JOIN knowledge_catalog_products kp ON kp.id=ka.product_id
      WHERE ka.alias_type='model' AND ${catalogRetrievalKeySql("ka.normalized_alias")} = json_extract(w.value,'$[2]')
      AND kp.verification_status='verified' AND kp.manufacturer_id=json_extract(w.value,'$[1]') LIMIT 65`)
          .bind(lookupJson),
      ])
    : [];
  if (lookups.some((result) => result.results.length > 64))
    throw new Error("auction_catalog_candidate_limit");
  const matches = lookups.flatMap((result) => result.results);
  const ids = [...new Set(matches.map((row) => row.id))];
  if (ids.length > 64) throw new Error("auction_catalog_candidate_limit");
  const manufacturers = [
    ...new Set(normalized.map((row) => row.manufacturer.canonicalManufacturerId).filter(Boolean)),
  ];
  const [products, modelAliases, profiles] = await db.batch<Record<string, string | number | null>>(
    [
      db
        .prepare(`SELECT p.id,p.manufacturer_id,p.canonical_model,p.canonical_name,c.category_id,c.is_primary
      FROM json_each(?) w CROSS JOIN knowledge_catalog_products p ON p.id=w.value
      LEFT JOIN knowledge_catalog_product_categories c ON c.product_id=p.id
      WHERE p.verification_status='verified' ORDER BY p.id,c.is_primary DESC,c.category_id LIMIT 257`)
        .bind(JSON.stringify(ids)),
      db
        .prepare(`SELECT a.product_id,a.alias FROM json_each(?) w CROSS JOIN knowledge_catalog_aliases a
      ON a.product_id=w.value WHERE a.alias_type='model' ORDER BY a.product_id,a.alias LIMIT 257`)
        .bind(JSON.stringify(ids)),
      db
        .prepare(`SELECT m.id,m.canonical_name,m.verification_status FROM json_each(?) w
      CROSS JOIN knowledge_catalog_manufacturers m ON m.id=w.value ORDER BY m.id LIMIT 21`)
        .bind(JSON.stringify(manufacturers)),
    ],
  );
  if (products.results.length > 256 || modelAliases.results.length > 256)
    throw new Error("auction_catalog_hydration_limit");
  const after = await clock();
  if (!before.results[0] || JSON.stringify(before.results) !== JSON.stringify(after.results))
    return [];
  const entries: AuctionCatalogEntry[] = [];
  for (const { input, manufacturer, model } of normalized) {
    const profile = profiles.results.find(
      (row) =>
        row.id === manufacturer.canonicalManufacturerId && row.verification_status === "verified",
    );
    const candidates: AuctionCatalogEntry["candidates"] = [];
    for (const id of new Set(
      matches.filter((match) => match.input_key === input.key).map((match) => match.id),
    )) {
      const rows = products.results.filter((row) => row.id === id);
      const row = rows[0];
      if (!row || !profile || row.manufacturer_id !== profile.id) continue;
      candidates.push({
        id,
        manufacturerId: String(row.manufacturer_id),
        canonicalModel: String(row.canonical_model),
        canonicalName: String(row.canonical_name),
        categoryIds: rows
          .map((row) => row.category_id)
          .filter((value): value is string => typeof value === "string"),
        aliases: modelAliases.results
          .filter((alias) => alias.product_id === id)
          .map((alias) => String(alias.alias)),
      });
    }
    const entry = {
      input,
      manufacturerId: profile ? manufacturer.canonicalManufacturerId : "",
      manufacturerName: profile ? String(profile.canonical_name) : "",
      model: model.model,
      candidates,
      rule: AUCTION_CATALOG_RULE,
    };
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(entry)),
    );
    entries.push({
      ...entry,
      revision: Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    });
  }
  return entries;
}
