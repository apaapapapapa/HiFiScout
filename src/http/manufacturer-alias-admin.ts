import { isRecord } from "../types.js";
import type { SaveManufacturerAliasInput } from "../db/manufacturer-repository.js";
import type { ManufacturerAliasReplayOptions } from "../db/manufacturer-repository.js";
import { optionalNonNegativeInteger, parseReplayRequest } from "./remediation-admin.js";

export interface ManufacturerAliasAdminRequest {
  input: SaveManufacturerAliasInput;
  replay: ManufacturerAliasReplayOptions;
}

function text(value: unknown, maxLength: number): string {
  return typeof value === "string" && value.trim().length <= maxLength ? value.trim() : "";
}

export function parseManufacturerAliasAdminRequest(
  value: unknown,
): ManufacturerAliasAdminRequest | null {
  if (!isRecord(value)) return null;
  const manufacturerId = text(value.manufacturerId, 100).toLowerCase();
  const canonicalName = text(value.canonicalName, 200);
  const alias = text(value.alias, 300);
  const source = text(value.source, 100);
  const verificationStatus = value.verificationStatus;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(manufacturerId)) return null;
  if (!canonicalName || !alias || !source) return null;
  if (
    verificationStatus !== "pending" &&
    verificationStatus !== "verified" &&
    verificationStatus !== "rejected"
  ) {
    return null;
  }
  const provenance = isRecord(value.provenance) ? value.provenance : {};
  if (new TextEncoder().encode(JSON.stringify(provenance)).byteLength > 4096) return null;
  const replay = parseReplayRequest(value);
  const ruleVersion = optionalNonNegativeInteger(value.ruleVersion);
  if (!replay) return null;
  if (value.ruleVersion != null && (ruleVersion === undefined || ruleVersion === 0)) return null;

  return {
    input: {
      manufacturerId,
      canonicalName,
      alias,
      verificationStatus,
      source,
      provenance,
      ruleVersion,
    },
    replay,
  };
}
