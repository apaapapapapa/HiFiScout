export const ADMIN_MANUFACTURER_PAGE_SIZE = 50;

export interface AdminManufacturerOption {
  id: string;
  name: string;
}

export interface AdminManufacturerQuery {
  query: string;
  afterId: string;
  limit: number;
}

export interface AdminManufacturerPage {
  items: AdminManufacturerOption[];
  hasMore: boolean;
  nextAfterId: string | null;
}

export function parseAdminManufacturerQuery(url: URL): AdminManufacturerQuery | null {
  const params = url.searchParams;
  if (
    [...params.keys()].some(
      (key) => !["q", "afterId", "limit"].includes(key) || params.getAll(key).length !== 1,
    )
  )
    return null;
  const query = (params.get("q") ?? "").normalize("NFKC").trim();
  const afterId = params.get("afterId") ?? "";
  const rawLimit = params.get("limit") ?? String(ADMIN_MANUFACTURER_PAGE_SIZE);
  const limit = Number(rawLimit);
  if (
    query.length > 100 ||
    /[\p{Cc}]/u.test(query) ||
    afterId.length > 100 ||
    (afterId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(afterId)) ||
    !/^\d+$/u.test(rawLimit) ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > ADMIN_MANUFACTURER_PAGE_SIZE
  )
    return null;
  return { query, afterId, limit };
}

export function isAdminManufacturerPage(value: unknown): value is AdminManufacturerPage {
  if (!value || typeof value !== "object") return false;
  const page = value as Partial<AdminManufacturerPage>;
  return (
    Array.isArray(page.items) &&
    page.items.length <= ADMIN_MANUFACTURER_PAGE_SIZE &&
    page.items.every(
      (item) =>
        item &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        item.id.length <= 100 &&
        typeof item.name === "string" &&
        item.name.length > 0,
    ) &&
    typeof page.hasMore === "boolean" &&
    (page.hasMore
      ? typeof page.nextAfterId === "string" &&
        page.nextAfterId.length > 0 &&
        page.nextAfterId === page.items.at(-1)?.id
      : page.nextAfterId === null)
  );
}

export interface AdminManufacturerEdit {
  manufacturerId: string;
  canonicalName: string;
  nameJa: string;
  nameEn: string;
  alias?: { alias: string; shopKey: string; enabled: boolean };
}
export interface AdminManufacturerAlias {
  alias: string;
  normalizedAlias: string;
  shopKey: string;
  status: "pending" | "verified" | "rejected";
  source: string;
}
export interface AdminManufacturerRegistryDetail {
  profile: Omit<AdminManufacturerEdit, "alias">;
  exists: boolean;
  aliases: AdminManufacturerAlias[];
  history: { operationId: string; createdAt: string; edit: AdminManufacturerEdit }[];
  observedAt: string;
}
export interface AdminManufacturerPreview<TSamples> {
  aliasBefore: AdminManufacturerAlias | null;
  revision: string;
  before: AdminManufacturerRegistryDetail;
  edit: AdminManufacturerEdit;
  scope: {
    shopKey: string;
    afterId: number;
    nextAfterId: number;
    maxId: number;
    scanned: number;
    matched: number;
    hasMore: boolean;
  };
  samples: TSamples;
  collisions: { alias: string; shopKey: string; manufacturerId: string; name: string }[];
}
export type AdminManufacturerCommand =
  | { action: "replay"; operationId: string }
  | { action: "get"; manufacturerId: string }
  | { action: "preview"; edit: AdminManufacturerEdit; afterId: number; maxId?: number }
  | { action: "apply"; edit: AdminManufacturerEdit; revision: string; operationId: string };
export interface AdminManufacturerApplyResult {
  applied: true;
  operationId: string;
  replay: "queued" | "pending";
  message: string;
}
