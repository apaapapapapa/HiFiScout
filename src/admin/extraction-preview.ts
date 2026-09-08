import { parseAdminExtractionRequest } from "../http/admin-extraction-preview.js";
import type {
  AdminExtractionFields,
  AdminExtractionRequest,
  AdminExtractionResult,
} from "../api/admin-listing-contracts.js";
import { isRecord } from "../types.js";
import {
  normalizeCatalogProduct,
  applyCategoryClassification,
} from "../catalog/product-normalizer.js";
import {
  createManufacturerResolver,
  applyManufacturerResolution,
  MANUFACTURER_RESOLVER_VERSION,
} from "../catalog/manufacturer-resolver.js";
import {
  createModelResolver,
  applyModelResolution,
  MODEL_RESOLVER_VERSION,
} from "../catalog/model-resolver.js";
import { normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { retainedCategoryEvidence } from "../catalog/retained-category-evidence.js";
import { classifyCategoryEvidence } from "../catalog/category-classifier.js";
import { componentCategoryIds, detectListingComponents } from "../catalog/listing-components.js";
import { TAXONOMY_VERSION } from "../catalog/categories.js";
import { getShopPlugin } from "../crawler/shops/index.js";
import { readAdminManufacturerAliases } from "../db/admin-manufacturer-registry.js";
import type { ReadableDatabase } from "../db/types.js";
import type { ManufacturerAliasEvidence, NormalizedCatalogProduct } from "../catalog/types.js";

interface SavedSample {
  id: number;
  title: string;
  shop_key: string;
  raw_manufacturer: string;
  raw_model: string;
  raw_category: string;
  canonical_manufacturer_id: string;
  manufacturer: string;
  model: string;
  normalized_model: string;
  primary_category_id: string;
  presentation_color: string;
  category: string;
  metadata_json: string;
  manufacturer_override: string | null;
  model_override: string | null;
  category_override: string | null;
  color_override: string | null;
}
const fields = (p: NormalizedCatalogProduct): AdminExtractionFields => ({
  manufacturerId: p.manufacturerId,
  manufacturer: p.manufacturer,
  model: p.model,
  normalizedModel: p.normalizedModel,
  categoryId: p.primaryCategoryId,
  color: p.presentationColor,
});

export async function previewAdminExtraction(
  db: ReadableDatabase,
  request: AdminExtractionRequest,
  dictionary?: { current: ManufacturerAliasEvidence[]; proposed: ManufacturerAliasEvidence[] },
): Promise<AdminExtractionResult> {
  const input = parseAdminExtractionRequest(request);
  if (!input) throw new Error("抽出テストの入力が正しくありません。");
  const ids = [
    ...new Set(input.samples.flatMap((row) => ("listingId" in row ? [row.listingId] : []))),
  ];
  const saved = ids.length
    ? (
        await db
          .prepare(`SELECT p.id, substr(p.title,1,4097) AS title, p.shop_key,
    substr(p.raw_manufacturer,1,4097) AS raw_manufacturer, substr(p.raw_model,1,4097) AS raw_model,
    substr(p.raw_category,1,4097) AS raw_category, p.canonical_manufacturer_id, p.manufacturer,
    p.model, p.normalized_model, p.primary_category_id, p.presentation_color, p.category,
    substr(p.metadata_json,1,64001) AS metadata_json, o.manufacturer_id AS manufacturer_override,
    o.model AS model_override, o.primary_category_id AS category_override, o.presentation_color AS color_override
    FROM products p LEFT JOIN product_admin_overrides o ON o.listing_product_id=p.id
    WHERE p.id IN (${ids.map(() => "?").join(",")})`)
          .bind(...ids)
          .all<SavedSample>()
      ).results
    : [];
  const byId = new Map(saved.map((row) => [row.id, row]));
  const aliases = dictionary?.current ?? (await readAdminManufacturerAliases(db));
  let draftEvidence: ManufacturerAliasEvidence | null = null;
  if (input.draftAlias) {
    const manufacturer = await db
      .prepare(
        "SELECT canonical_name FROM knowledge_catalog_manufacturers WHERE id=? AND verification_status='verified'",
      )
      .bind(input.draftAlias.manufacturerId)
      .first<{ canonical_name: string }>();
    if (!manufacturer) throw new Error("仮ルールには確認済みメーカーを選択してください。");
    draftEvidence = {
      manufacturerId: input.draftAlias.manufacturerId,
      shopKey: input.draftAlias.shopKey,
      canonicalName: manufacturer.canonical_name,
      alias: input.draftAlias.alias,
      normalizedAlias: normalizeManufacturerKey(input.draftAlias.alias),
      verificationStatus: "verified",
      source: "admin_preview",
      ruleVersion: MANUFACTURER_RESOLVER_VERSION,
    };
  }
  const baseResolvers = {
    manufacturer: createManufacturerResolver(aliases),
    model: createModelResolver(aliases),
  };
  const proposedAliases =
    dictionary?.proposed ??
    (draftEvidence
      ? [
          draftEvidence,
          ...aliases.filter(
            (row) =>
              !(
                row.manufacturerId === draftEvidence.manufacturerId &&
                row.normalizedAlias === draftEvidence.normalizedAlias &&
                (row.shopKey ?? "") === (draftEvidence.shopKey ?? "")
              ),
          ),
        ]
      : aliases);
  const draftResolvers =
    draftEvidence || dictionary
      ? {
          manufacturer: createManufacturerResolver(proposedAliases),
          model: createModelResolver(proposedAliases),
        }
      : baseResolvers;
  const items = input.samples.map((sample): AdminExtractionResult["items"][number] => {
    const listingId = "listingId" in sample ? sample.listingId : null;
    const row = listingId ? byId.get(listingId) : undefined;
    const raw =
      "listingId" in sample
        ? {
            title: row?.title ?? "",
            rawManufacturer: row?.raw_manufacturer ?? "",
            rawModel: row?.raw_model ?? "",
            rawCategory: row?.raw_category ?? "",
            shopKey: row?.shop_key ?? "",
          }
        : sample;
    const empty = {
      listingId,
      title: raw.title,
      shopKey: raw.shopKey,
      saved: null,
      current: null,
      proposed: null,
      withOverrides: null,
      overrides: [],
      reasons: null,
    };
    if (listingId && !row) return { ...empty, error: "商品が見つかりません。" };
    if (
      Object.values(raw).some((value) => value.length > 4096) ||
      (row?.metadata_json.length ?? 0) > 64_000
    )
      return { ...empty, error: "保存済み情報がプレビュー上限を超えています。" };
    let parsed: unknown = {};
    try {
      parsed = row ? JSON.parse(row.metadata_json || "{}") : {};
    } catch {
      return { ...empty, error: "保存済みの補足情報を読み込めません。" };
    }
    const metadata = isRecord(parsed) ? parsed : {};
    const config = getShopPlugin(raw.shopKey)?.capabilities.catalog ?? {};
    const source = normalizeCatalogProduct(
      {
        ...raw,
        sourceId: "preview",
        sourceUrl: "",
        manufacturer: raw.rawManufacturer,
        model: raw.rawModel,
        conditionText: "",
        priceYen: null,
        stockStatus: "unknown",
        metadata,
      },
      config,
      { shopKey: raw.shopKey },
    );
    const evidence = row
      ? retainedCategoryEvidence(
          { title: raw.title, rawCategory: raw.rawCategory, hintedCategory: row.category },
          metadata,
        )
      : source.categoryEvidence;
    const extract = (resolvers: typeof baseResolvers) => {
      let product = applyModelResolution(
        applyManufacturerResolution(source, resolvers.manufacturer, raw.shopKey),
        resolvers.model,
        raw.shopKey,
      );
      const components = detectListingComponents(
        { title: raw.title, rawModel: raw.rawModel },
        { manufacturerId: product.manufacturerId, shopKey: raw.shopKey },
      );
      product = applyCategoryClassification(
        { ...product, componentCategoryIds: componentCategoryIds(components.components) },
        classifyCategoryEvidence(evidence),
        evidence,
      );
      return product;
    };
    const current = extract(baseResolvers);
    const proposed =
      dictionary ||
      (input.draftAlias && (!input.draftAlias.shopKey || input.draftAlias.shopKey === raw.shopKey))
        ? extract(draftResolvers)
        : current;
    const display = fields(proposed);
    const overrides: string[] = [];
    if (row?.manufacturer_override != null) {
      display.manufacturerId = row.manufacturer_override;
      display.manufacturer = row.manufacturer;
      overrides.push("メーカー");
    }
    if (row?.model_override != null) {
      display.model = row.model;
      display.normalizedModel = row.normalized_model;
      overrides.push("型番");
    }
    if (row?.category_override != null) {
      display.categoryId = row.category_override;
      overrides.push("カテゴリ");
    }
    if (row?.color_override != null) {
      display.color = row.color_override;
      overrides.push("色");
    }
    return {
      listingId,
      title: raw.title,
      shopKey: raw.shopKey,
      saved: row
        ? {
            manufacturerId: row.canonical_manufacturer_id,
            manufacturer: row.manufacturer,
            model: row.model,
            normalizedModel: row.normalized_model,
            categoryId: row.primary_category_id,
            color: row.presentation_color,
          }
        : null,
      current: fields(current),
      proposed: fields(proposed),
      withOverrides: display,
      overrides,
      reasons: {
        manufacturer: `${proposed.manufacturerResolutionStatus} / ${proposed.manufacturerResolutionMethod}`,
        model: `${proposed.modelResolutionStatus} / ${proposed.modelResolutionMethod}`,
        category: proposed.classificationReason,
      },
    };
  });
  return {
    observedAt: new Date().toISOString(),
    versions: {
      manufacturer: MANUFACTURER_RESOLVER_VERSION,
      model: MODEL_RESOLVER_VERSION,
      taxonomy: TAXONOMY_VERSION,
    },
    items,
  };
}
