/**
 * Product-level ordering and keyset pagination.
 *
 * The public `?sort=` vocabulary survived Phase 4, but every value is now defined over offer
 * aggregates rather than one listing's columns:
 *
 * - `newest` / `oldest` — newest listing/publication time across the product's active offers,
 *   descending and ascending. Both read the same aggregate, so they are exact inverses: `oldest`
 *   means "the product whose most recent offer is the least recent", not a different column.
 * - `updated` — most recent meaningful listing activity across the product's active offers.
 * - `priceAsc` / `priceDesc` — the product's lowest offer price. When the caller asked for in-stock
 *   offers the aggregate switches to the lowest *in-stock* price, so "cheapest first" never orders
 *   by a price that is not for sale.
 * - `dealScore` — persisted basis-point deviation from the retained asking-price median. Negative
 *   values are cheaper relative to the product's own market, so ascending order is best-deal first.
 *
 * Unfiltered sorts read the stored entity aggregates. A request that narrows offers beyond what a
 * stored aggregate represents may instead order by a request-scoped aggregate supplied by the
 * repository; the cursor carries the matching sort key so it cannot resume under a different
 * ordering. NULL aggregates sort last in both directions.
 */

import type { ProductQuerySort } from "../api/contracts.js";
import { isRecord } from "../types.js";
import type {
  ProductSearchCursor,
  ProductSearchEntityRow,
  ProductSearchSortDefinition,
} from "./types.js";

// Step 5 adds this persistence-only ordering column without widening the public entity DTO. The
// repository selects it as `request_sort_value` for cursor minting, so it never leaks into API rows.
const DEAL_SCORE_COLUMN = "deal_score" as ProductSearchSortDefinition["column"];

const ACTIVITY_SORTS: Readonly<Record<ProductQuerySort, ProductSearchSortDefinition | null>> = {
  newest: {
    key: "newest",
    column: "newest_listed_at",
    direction: "DESC",
    idDirection: "DESC",
  },
  oldest: {
    key: "oldest",
    column: "newest_listed_at",
    direction: "ASC",
    idDirection: "ASC",
  },
  updated: {
    key: "updated",
    column: "latest_activity_at",
    direction: "DESC",
    idDirection: "DESC",
  },
  priceAsc: null,
  priceDesc: null,
  dealScore: {
    key: "dealScore",
    column: DEAL_SCORE_COLUMN,
    direction: "ASC",
    idDirection: "ASC",
  },
};

export function sortDefinition(
  sort: ProductQuerySort,
  inStockOnly: boolean,
): ProductSearchSortDefinition {
  const activity = ACTIVITY_SORTS[sort];
  if (activity) return activity;
  const column = inStockOnly ? "lowest_in_stock_price_yen" : "lowest_price_yen";
  const direction = sort === "priceAsc" ? "ASC" : "DESC";
  return {
    key: `${sort}:${inStockOnly ? "inStock" : "any"}`,
    column,
    direction,
    idDirection: direction,
  };
}

export function sortOrderBy(
  sort: ProductSearchSortDefinition,
  column = `e.${sort.column}`,
): string {
  return `${column} ${sort.direction} NULLS LAST, e.id ${sort.idDirection}`;
}

export function encodeCursor(payload: ProductSearchCursor): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

/** Untrusted input: any malformed cursor decodes to `null` and the caller starts from the top. */
export function decodeCursor(value: string | null): ProductSearchCursor | null {
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
 * `column` is normally the stored entity aggregate, but the repository can supply an equivalent
 * request-scoped aggregate when offer filters changed the meaning of the sort. A cursor minted for
 * a different ordering is ignored rather than rejected.
 */
export function addCursorPredicate(
  where: string[],
  binds: unknown[],
  sort: ProductSearchSortDefinition,
  cursor: ProductSearchCursor | null,
  column = `e.${sort.column}`,
): void {
  if (!cursor || cursor.sort !== sort.key) return;
  const idOp = sort.idDirection === "DESC" ? "<" : ">";
  if (cursor.isNull) {
    where.push(`(${column} IS NULL AND e.id ${idOp} ?)`);
    binds.push(cursor.id);
    return;
  }
  if (typeof cursor.value !== "string" && typeof cursor.value !== "number") return;
  const op = sort.direction === "DESC" ? "<" : ">";
  where.push(`(${column} IS NULL OR ${column} ${op} ? OR (${column} = ? AND e.id ${idOp} ?))`);
  binds.push(cursor.value, cursor.value, cursor.id);
}

/**
 * Mints the cursor from the value the ORDER BY actually used.
 *
 * `valueOverride` is supplied for a request-scoped aggregate or the persistence-only deal score;
 * otherwise the stored DTO-backed entity column remains the source. The tie-breaker is the internal
 * entity id, which is never exposed directly.
 */
export function cursorFor(
  row: ProductSearchEntityRow,
  sort: ProductSearchSortDefinition,
  valueOverride?: string | number | null,
): string {
  const value = valueOverride === undefined ? (row[sort.column] ?? null) : valueOverride;
  return encodeCursor({ sort: sort.key, id: Number(row.id), value, isNull: value == null });
}
