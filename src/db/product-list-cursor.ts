/**
 * Keyset pagination for the product list.
 *
 * The cursor is an opaque base64url payload carrying the sort key it was minted for, so a client
 * that changes `?sort=` mid-scroll gets a fresh first page instead of a corrupt window. Encoding,
 * decoding and the matching SQL predicate live together because they must stay symmetric.
 */

import type { ProductListItem, ProductQuerySort } from "../api/contracts.js";
import { isRecord } from "../types.js";
import type { ProductListCursor, SortDefinition } from "./types.js";

const SORT_DEFINITIONS: Readonly<Record<ProductQuerySort, SortDefinition>> = {
  newest: { key: "newest", column: "last_activity_at", direction: "DESC", idDirection: "DESC" },
  oldest: { key: "oldest", column: "last_activity_at", direction: "ASC", idDirection: "ASC" },
  updated: { key: "updated", column: "last_activity_at", direction: "DESC", idDirection: "DESC" },
  priceAsc: {
    key: "priceAsc",
    column: "price_yen",
    direction: "ASC",
    idDirection: "ASC",
    price: true,
  },
  priceDesc: {
    key: "priceDesc",
    column: "price_yen",
    direction: "DESC",
    idDirection: "DESC",
    price: true,
  },
};

export function sortDefinition(sort: ProductQuerySort): SortDefinition {
  return SORT_DEFINITIONS[sort];
}

/** `ORDER BY` for a non-relevance listing. Price sorts push NULLs last so the index can serve it. */
export function sortOrderBy(sort: SortDefinition): string {
  return sort.price
    ? `p.price_yen ${sort.direction} NULLS LAST, p.id ${sort.idDirection}`
    : `p.${sort.column} ${sort.direction}, p.id ${sort.idDirection}`;
}

export function encodeCursor(payload: ProductListCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Untrusted input: any malformed cursor decodes to `null` and the caller starts from the top. */
export function decodeCursor(value: string | null): ProductListCursor | null {
  if (!value) return null;
  try {
    const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
    const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
    const binary = atob(normalized + padding);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!isRecord(parsed) || !Number.isInteger(parsed.id) || typeof parsed.sort !== "string") {
      return null;
    }
    return {
      id: Number(parsed.id),
      sort: parsed.sort,
      ...(typeof parsed.value === "string" ||
      typeof parsed.value === "number" ||
      parsed.value === null
        ? { value: parsed.value }
        : {}),
      ...(typeof parsed.isNull === "boolean" ? { isNull: parsed.isNull } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Appends the `WHERE` predicate that resumes after `cursor`.
 *
 * A cursor minted for a different sort key is ignored rather than rejected, which keeps a stale
 * bookmark from erroring the request. Price sorts need the extra `IS NULL` arm because NULL
 * prices are ordered last and cannot be compared with `<`/`>`.
 */
export function addCursorPredicate(
  where: string[],
  binds: unknown[],
  sort: SortDefinition,
  cursor: ProductListCursor | null,
): void {
  if (!cursor || cursor.sort !== sort.key) return;
  if (!sort.price) {
    if (typeof cursor.value !== "string") return;
    const op = sort.direction === "DESC" ? "<" : ">";
    const idOp = sort.idDirection === "DESC" ? "<" : ">";
    where.push(`(p.${sort.column} ${op} ? OR (p.${sort.column} = ? AND p.id ${idOp} ?))`);
    binds.push(cursor.value, cursor.value, cursor.id);
    return;
  }
  const idOp = sort.idDirection === "DESC" ? "<" : ">";
  if (cursor.isNull) {
    where.push(`(p.price_yen IS NULL AND p.id ${idOp} ?)`);
    binds.push(cursor.id);
    return;
  }
  if (typeof cursor.value !== "number") return;
  const priceOp = sort.direction === "DESC" ? "<" : ">";
  where.push(
    `(p.price_yen IS NULL OR p.price_yen ${priceOp} ? OR (p.price_yen = ? AND p.id ${idOp} ?))`,
  );
  binds.push(cursor.value, cursor.value, cursor.id);
}

export function cursorFor(item: ProductListItem, sort: SortDefinition): string {
  return encodeCursor({
    sort: sort.key,
    id: item.id,
    value: item[sort.column],
    isNull: sort.price ? item.price_yen == null : false,
  });
}
