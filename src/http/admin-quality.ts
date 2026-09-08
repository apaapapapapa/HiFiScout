import type {
  AdminQualityCommand,
  AdminQualityReportCursor,
  AdminQualityCandidateCursor,
} from "../api/admin-listing-contracts.js";
import { getShopPlugin } from "../crawler/shops/index.js";
import { isRecord } from "../types.js";
const integer = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const text = (value: unknown, max: number) =>
  typeof value === "string" && value.length <= max && !/[\p{Cc}]/u.test(value);
export function parseAdminQualityCommand(value: unknown): AdminQualityCommand | null {
  if (!isRecord(value)) return null;
  if (value.action === "overview") return { action: "overview" };
  if (value.action === "report")
    return integer(value.id) && Number(value.id) > 0
      ? { action: "report", id: Number(value.id) }
      : null;
  if (
    value.action === "samples" &&
    typeof value.shopKey === "string" &&
    getShopPlugin(value.shopKey) &&
    ["manufacturer", "category", "identity_veto", "identity_candidate"].includes(
      String(value.kind),
    ) &&
    typeof value.kind === "string" &&
    integer(value.afterId)
  )
    return {
      action: "samples",
      shopKey: value.shopKey,
      kind: value.kind as Extract<AdminQualityCommand, { action: "samples" }>["kind"],
      afterId: Number(value.afterId),
    };
  if (value.action === "reports") {
    const cursor = value.before;
    if (
      cursor !== undefined &&
      (!Array.isArray(cursor) ||
        cursor.length !== 5 ||
        !integer(cursor[0]) ||
        !integer(cursor[1]) ||
        !text(cursor[2], 40) ||
        !text(cursor[3], 500) ||
        !text(cursor[4], 50))
    )
      return null;
    return {
      action: "reports",
      ...(cursor === undefined ? {} : { before: cursor as AdminQualityReportCursor }),
    };
  }
  if (value.action === "candidates") {
    const cursor = value.before;
    if (
      cursor !== undefined &&
      (!Array.isArray(cursor) ||
        cursor.length !== 3 ||
        !integer(cursor[0]) ||
        !text(cursor[1], 40) ||
        !integer(cursor[2]))
    )
      return null;
    return {
      action: "candidates",
      ...(cursor === undefined ? {} : { before: cursor as AdminQualityCandidateCursor }),
    };
  }
  return null;
}
