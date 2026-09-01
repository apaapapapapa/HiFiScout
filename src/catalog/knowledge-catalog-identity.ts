/**
 * Catalog logical identity: the one rule that decides whether two Knowledge Catalog rows name the
 * same product.
 *
 * `UNIQUE(manufacturer_id, normalized_model)` protects the *storage* key produced by
 * {@link normalizeCatalogModel}, which deliberately keeps separators and revision spellings so an
 * admin sees the model the way a manufacturer writes it. Product Identity resolution matches on
 * {@link normalizeIdentityModel} instead, which drops both. The storage key therefore admits rows
 * that Product Identity already considers one product -- `C-10` and `C10`, `L-509 MK II` and
 * `L-509MKII`, `bw` and `bowers-wilkins` -- and a lookup that only compares storage keys creates a
 * second Catalog row for a product that already exists.
 *
 * Everything that asks "is this the same product?" -- promotion, manual admin writes, duplicate
 * detection, and duplicate convergence -- resolves that question here, so the four cannot drift
 * apart again.
 */

import { manufacturerFilterIds, manufacturerIdForFilter } from "./manufacturers.js";
import { normalizeIdentityModel } from "./product-identity.js";

export interface CatalogIdentity {
  /** Canonical manufacturer id, so a legacy id resolves onto the manufacturer it names. */
  readonly manufacturerId: string;
  /** Identity-normalized model, so separators and revision spellings cannot split a product. */
  readonly model: string;
}

function rawManufacturerId(value: unknown): string {
  return String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLowerCase();
}

/**
 * The manufacturer id two Catalog rows must share to be the same product. Unknown manufacturers
 * keep their stored id rather than collapsing into one another.
 */
export function catalogIdentityManufacturerId(value: unknown = ""): string {
  return manufacturerIdForFilter(value) || rawManufacturerId(value);
}

/** The model two Catalog rows must share to be the same product. */
export function catalogIdentityModel(value: unknown = ""): string {
  return normalizeIdentityModel(value);
}

/**
 * The logical identity of one Catalog row, or `null` when the model normalizes away entirely. A
 * model with no identity carries nothing to compare, so it is never the same product as anything.
 */
export function catalogIdentity(manufacturerId: unknown, model: unknown): CatalogIdentity | null {
  const identityModel = catalogIdentityModel(model);
  if (!identityModel) return null;
  return { manufacturerId: catalogIdentityManufacturerId(manufacturerId), model: identityModel };
}

/** Groupable spelling of {@link catalogIdentity}; `""` when the row carries no identity. */
export function catalogIdentityKey(manufacturerId: unknown, model: unknown): string {
  const identity = catalogIdentity(manufacturerId, model);
  return identity ? `${identity.manufacturerId} ${identity.model}` : "";
}

/** Whether two Catalog rows name one product under the rule above. */
export function sameCatalogIdentity(
  left: { manufacturerId: unknown; model: unknown },
  right: { manufacturerId: unknown; model: unknown },
): boolean {
  const key = catalogIdentityKey(left.manufacturerId, left.model);
  return Boolean(key) && key === catalogIdentityKey(right.manufacturerId, right.model);
}

/**
 * Every stored `manufacturer_id` that may hold a row for one manufacturer, canonical id first.
 * A SQL scan filtered by these ids keeps the legacy-id duplicates inside the scan.
 */
export function catalogIdentityManufacturerIds(value: unknown = ""): string[] {
  return [...new Set([rawManufacturerId(value), ...manufacturerFilterIds(value)])].filter(Boolean);
}
