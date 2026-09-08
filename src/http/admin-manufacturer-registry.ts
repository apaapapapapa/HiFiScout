import type {
  AdminManufacturerCommand,
  AdminManufacturerEdit,
} from "../api/admin-manufacturer-contracts.js";
import { normalizeManufacturerKey } from "../catalog/manufacturers.js";
import { getShopPlugin } from "../crawler/shops/index.js";
import { isRecord } from "../types.js";
const id = (value: unknown): value is string =>
  typeof value === "string" && value.length <= 100 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value);
const name = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 100 &&
  !/[\p{Cc}]/u.test(value) &&
  value === value.trim();
function edit(value: unknown): AdminManufacturerEdit | null {
  if (
    !isRecord(value) ||
    !id(value.manufacturerId) ||
    !name(value.canonicalName) ||
    !normalizeManufacturerKey(value.canonicalName) ||
    !name(value.nameJa) ||
    !name(value.nameEn)
  )
    return null;
  const result: AdminManufacturerEdit = {
    manufacturerId: value.manufacturerId,
    canonicalName: value.canonicalName,
    nameJa: value.nameJa,
    nameEn: value.nameEn,
  };
  if (value.alias !== undefined) {
    const alias = value.alias;
    if (
      !isRecord(alias) ||
      !name(alias.alias) ||
      !normalizeManufacturerKey(alias.alias) ||
      typeof alias.shopKey !== "string" ||
      (alias.shopKey !== "" && !getShopPlugin(alias.shopKey)) ||
      typeof alias.enabled !== "boolean"
    )
      return null;
    result.alias = { alias: alias.alias, shopKey: alias.shopKey, enabled: alias.enabled };
  }
  return result;
}
export function parseAdminManufacturerCommand(value: unknown): AdminManufacturerCommand | null {
  if (!isRecord(value)) return null;
  if (value.action === "replay")
    return typeof value.operationId === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
        value.operationId,
      )
      ? { action: "replay", operationId: value.operationId }
      : null;
  if (value.action === "get")
    return id(value.manufacturerId)
      ? { action: "get", manufacturerId: value.manufacturerId }
      : null;
  const parsed = edit(value.edit);
  if (!parsed) return null;
  if (value.action === "preview") {
    if (
      !Number.isSafeInteger(value.afterId) ||
      Number(value.afterId) < 0 ||
      (value.maxId !== undefined && (!Number.isSafeInteger(value.maxId) || Number(value.maxId) < 0))
    )
      return null;
    return {
      action: "preview",
      edit: parsed,
      afterId: Number(value.afterId),
      ...(typeof value.maxId === "number" ? { maxId: value.maxId } : {}),
    };
  }
  if (
    value.action === "apply" &&
    typeof value.revision === "string" &&
    /^[a-f0-9]{64}$/u.test(value.revision) &&
    typeof value.operationId === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(
      value.operationId,
    )
  )
    return {
      action: "apply",
      edit: parsed,
      revision: value.revision,
      operationId: value.operationId,
    };
  return null;
}
