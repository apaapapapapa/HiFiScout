import type { CatalogPhoto, CatalogPhotoSnapshot, CatalogPhotoUpdate } from "../catalog/types.js";
export type { CatalogPhoto, CatalogPhotoSnapshot, CatalogPhotoUpdate } from "../catalog/types.js";

export function safePhotoUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    // These URLs are rendered by browsers, including browsers on private networks.
    const host = url.hostname.toLowerCase().replace(/\.$/, "");
    if (
      !host.includes(".") ||
      /^[\d.]+$/.test(host) ||
      host.includes(":") ||
      /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

export function parseCatalogPhoto(value: unknown): CatalogPhoto | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const imageUrl = safePhotoUrl(record.imageUrl);
  const sourceUrl = safePhotoUrl(record.sourceUrl);
  if (!imageUrl || !sourceUrl || typeof record.credit !== "string" || record.credit.length > 200)
    return null;
  return { imageUrl, sourceUrl, credit: record.credit.trim() };
}

export function parseCatalogPhotoUpdate(value: unknown): CatalogPhotoUpdate | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.expectedRevision !== "number" ||
    !Number.isSafeInteger(record.expectedRevision) ||
    record.expectedRevision < 0
  )
    return null;
  const photo = parseCatalogPhoto(record.photo);
  return record.photo === null || photo
    ? { photo, expectedRevision: record.expectedRevision }
    : null;
}

export function isCatalogPhotoSnapshot(value: unknown): value is CatalogPhotoSnapshot {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.productId === "number" &&
    Number.isSafeInteger(record.productId) &&
    record.productId > 0 &&
    parseCatalogPhotoUpdate({ photo: record.photo, expectedRevision: record.revision }) !== null
  );
}
