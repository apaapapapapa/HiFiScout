import type {
  AdminExtractionRequest,
  AdminExtractionSample,
} from "../api/admin-listing-contracts.js";
import { isRecord } from "../types.js";
import { getShopPlugin } from "../crawler/shops/index.js";
import { normalizeManufacturerKey } from "../catalog/manufacturers.js";

const cleanText = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !/[\p{Cc}]/u.test(value);
export function parseAdminExtractionRequest(value: unknown): AdminExtractionRequest | null {
  if (
    !isRecord(value) ||
    !Array.isArray(value.samples) ||
    !value.samples.length ||
    value.samples.length > 20
  )
    return null;
  const samples: AdminExtractionSample[] = [];
  for (const row of value.samples) {
    if (!isRecord(row)) return null;
    if (Number.isSafeInteger(row.listingId) && Number(row.listingId) > 0) {
      samples.push({ listingId: Number(row.listingId) });
      continue;
    }
    if (
      !cleanText(row.title, 4096) ||
      !String(row.title).trim() ||
      !cleanText(row.rawManufacturer, 4096) ||
      !cleanText(row.rawModel, 4096) ||
      !cleanText(row.rawCategory, 4096) ||
      typeof row.shopKey !== "string" ||
      (row.shopKey !== "" && !getShopPlugin(row.shopKey))
    )
      return null;
    samples.push({
      title: String(row.title),
      rawManufacturer: String(row.rawManufacturer),
      rawModel: String(row.rawModel),
      rawCategory: String(row.rawCategory),
      shopKey: row.shopKey,
    });
  }
  const result: AdminExtractionRequest = { samples };
  if (value.draftAlias !== undefined) {
    const draft = value.draftAlias;
    if (
      !isRecord(draft) ||
      typeof draft.manufacturerId !== "string" ||
      !/^[a-z0-9-]{1,100}$/u.test(draft.manufacturerId) ||
      !cleanText(draft.alias, 100) ||
      !normalizeManufacturerKey(draft.alias) ||
      typeof draft.shopKey !== "string" ||
      (draft.shopKey !== "" && !getShopPlugin(draft.shopKey))
    )
      return null;
    result.draftAlias = {
      manufacturerId: draft.manufacturerId,
      alias: String(draft.alias),
      shopKey: draft.shopKey,
    };
  }
  return result;
}
