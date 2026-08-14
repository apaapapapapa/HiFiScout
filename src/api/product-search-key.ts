/**
 * The public identifier for a search entity.
 *
 * Two different id spaces reach the browser — Knowledge Catalog product ids and seller listing ids
 * — and they overlap numerically. Namespacing them into one opaque string means a client can route
 * on a result without ever having to know which kind it holds, and a catalog id can never be
 * silently read as a listing id (or vice versa) by a URL that was hand-edited or bookmarked.
 *
 * The prefix is deliberately part of the stored `entity_key` too, so the wire value and the
 * database value are the same string and no translation table is needed.
 */

import type { ProductSearchIdentityKind } from "./contracts.js";

const KEY_PATTERN = /^(?<prefix>c|l)-(?<id>\d{1,15})$/u;

export interface ProductSearchKey {
  kind: ProductSearchIdentityKind;
  id: number;
}

export function productSearchKey(kind: ProductSearchIdentityKind, id: number): string {
  return `${kind === "catalog" ? "c" : "l"}-${id}`;
}

/** Untrusted input: anything that is not a well-formed key decodes to `null` for a 400/404. */
export function parseProductSearchKey(value: string | null | undefined): ProductSearchKey | null {
  const groups = KEY_PATTERN.exec(String(value ?? ""))?.groups;
  if (!groups) return null;
  const id = Number(groups.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return { kind: groups.prefix === "c" ? "catalog" : "unresolved_listing", id };
}
