import type {
  CatalogSpecifications,
  CatalogSpecificationRecord,
  SpecificationPort,
} from "../catalog/types.js";
export type {
  CatalogSpecifications,
  CatalogSpecificationRecord,
  SpecificationPort,
} from "../catalog/types.js";

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): v is string =>
  typeof v === "string" && v.trim().length > 0 && v.length <= max;

export const SPECIFICATION_FILTER_DEFINITIONS = [
  { id: "maxWidthMm", name: "幅の上限", unit: "mm", maximum: 100000, integer: false },
  { id: "maxHeightMm", name: "高さの上限", unit: "mm", maximum: 100000, integer: false },
  { id: "maxDepthMm", name: "奥行の上限", unit: "mm", maximum: 100000, integer: false },
  { id: "maxWeightKg", name: "重量の上限", unit: "kg", maximum: 100000, integer: false },
  { id: "minXlrInputs", name: "XLR入力の下限", unit: "系統", maximum: 128, integer: true },
  { id: "minXlrOutputs", name: "XLR出力の下限", unit: "系統", maximum: 128, integer: true },
  { id: "minRcaInputs", name: "RCA入力の下限", unit: "系統", maximum: 128, integer: true },
  { id: "minRcaOutputs", name: "RCA出力の下限", unit: "系統", maximum: 128, integer: true },
] as const;
export type SpecificationFilterId = (typeof SPECIFICATION_FILTER_DEFINITIONS)[number]["id"];
export type SpecificationFilterValues = Partial<Record<SpecificationFilterId, string>>;
export type SpecificationFilterQuery = Partial<Record<SpecificationFilterId, number>>;

export function parseSpecificationFilterValue(id: SpecificationFilterId, value: string): number | null {
  const definition = SPECIFICATION_FILTER_DEFINITIONS.find((entry) => entry.id === id);
  const normalized = value.normalize("NFKC").trim();
  if (!definition || !/^\d{1,6}(?:\.\d{1,3})?$/.test(normalized)) return null;
  const number = Number(normalized);
  return number > 0 && number <= definition.maximum && (!definition.integer || Number.isInteger(number)) ? number : null;
}

/** Reject invalid units, counts and links at both the RPC and browser boundaries. */
export function parseCatalogSpecifications(value: unknown): CatalogSpecifications | null {
  if (!record(value)) return null;
  for (const key of ["widthMm", "heightMm", "depthMm", "weightKg"] as const) {
    const n = value[key];
    if (n !== null && (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 100000))
      return null;
  }
  for (const key of ["inputs", "outputs"] as const) {
    const ports = value[key];
    if (ports === null) continue;
    if (!Array.isArray(ports) || ports.length > 16) return null;
    if (
      ports.some(
        (p) =>
          !record(p) ||
          !text(p.connector, 60) ||
          (p.count !== null &&
            (typeof p.count !== "number" ||
              !Number.isInteger(p.count) ||
              p.count < 1 ||
              p.count > 128)),
      )
    )
      return null;
    if (new Set(ports.map((p) => p.connector.trim())).size !== ports.length) return null;
  }
  if (
    !Array.isArray(value.main) ||
    value.main.length > 12 ||
    value.main.some((p) => !record(p) || !text(p.name, 60) || !text(p.value, 200))
  )
    return null;
  if (new Set(value.main.map((p) => p.name.trim())).size !== value.main.length) return null;
  if (!text(value.sourceUrl, 2048)) return null;
  try {
    const url = new URL(value.sourceUrl);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return null;
  } catch {
    return null;
  }
  const ports = (key: "inputs" | "outputs") =>
    (value[key] as SpecificationPort[] | null)?.map((p) => ({
      connector: p.connector.trim(),
      count: p.count,
    })) ?? null;
  return {
    widthMm: value.widthMm as number | null,
    heightMm: value.heightMm as number | null,
    depthMm: value.depthMm as number | null,
    weightKg: value.weightKg as number | null,
    inputs: ports("inputs"),
    outputs: ports("outputs"),
    main: value.main.map((p) => ({ name: p.name.trim(), value: p.value.trim() })),
    sourceUrl: value.sourceUrl.trim(),
  };
}

export function isCatalogSpecificationRecord(value: unknown): value is CatalogSpecificationRecord {
  return (
    record(value) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    parseCatalogSpecifications(value) !== null
  );
}
