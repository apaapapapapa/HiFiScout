import type { AdminJobCommand } from "../api/admin-csv-contracts.js";
import { ADMIN_CSV_MAX_ROWS, ADMIN_CSV_PREVIEW_LIMIT } from "../api/admin-csv-contracts.js";
import { parseAdminCsvApply } from "./admin-csv-import.js";
import { isRecord } from "../types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
export function parseAdminJobCommand(value: unknown): AdminJobCommand | null {
  if (!isRecord(value)) return null;
  if (value.action === "list") {
    if (
      value.before !== undefined &&
      (typeof value.before !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z~[a-f\d-]{36}$/iu.test(value.before))
    )
      return null;
    return {
      action: "list",
      ...(typeof value.before === "string" ? { before: value.before } : {}),
    };
  }
  if (typeof value.id !== "string" || !UUID.test(value.id)) return null;
  const id = value.id;
  switch (value.action) {
    case "get":
      if (value.failedOnly !== undefined && typeof value.failedOnly !== "boolean") return null;
      if (
        value.after !== undefined &&
        (!Number.isSafeInteger(value.after) || Number(value.after) < -1)
      )
        return null;
      return {
        action: "get",
        id,
        ...(typeof value.after === "number" ? { after: value.after } : {}),
        ...(value.failedOnly === true ? { failedOnly: true } : {}),
      };
    case "create":
      if (
        (value.kind !== "csv" && value.kind !== "replay" && value.kind !== "manufacturer") ||
        !Number.isSafeInteger(value.total) ||
        Number(value.total) < 0 ||
        Number(value.total) > ADMIN_CSV_MAX_ROWS ||
        (value.kind === "csv" && value.total === 0) ||
        (value.kind !== "csv" && value.total !== 0) ||
        typeof value.label !== "string" ||
        value.label.length > 100
      )
        return null;
      return {
        action: "create",
        id,
        kind: value.kind,
        total: Number(value.total),
        label: value.label,
      };
    case "append": {
      if (
        !Number.isSafeInteger(value.offset) ||
        Number(value.offset) < 0 ||
        !Array.isArray(value.items) ||
        !value.items.length ||
        value.items.length > ADMIN_CSV_PREVIEW_LIMIT
      )
        return null;
      const items = value.items.map(parseAdminCsvApply);
      if (items.some((item) => !item)) return null;
      return {
        action: "append",
        id,
        offset: Number(value.offset),
        items: items.filter((item) => item !== null),
      };
    }
    case "start":
    case "pause":
    case "resume":
    case "retry":
    case "cancel":
      return { action: value.action, id };
    default:
      return null;
  }
}
