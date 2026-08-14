/** Page-number arithmetic for the listing pager. Pure, so the window logic is directly testable. */

export const PAGE_SIZE = 50;

/** Above this many pages the pager elides the middle instead of listing every page. */
const DENSE_LIMIT = 7;

/**
 * The page numbers a pager should offer.
 *
 * Always includes the first and last page so a user can jump to either end; gaps between the
 * returned numbers are where the caller draws an ellipsis.
 */
export function pageNumbers(currentPage: number, totalPages: number): number[] {
  if (totalPages <= 0) return [];
  if (totalPages <= DENSE_LIMIT) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }
  if (currentPage <= 4) return [1, 2, 3, 4, 5, totalPages];
  if (currentPage >= totalPages - 3) {
    return [1, totalPages - 4, totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }
  return [1, currentPage - 1, currentPage, currentPage + 1, totalPages];
}

/** Offset of a 1-based page, for the `offset=` fallback when no cursor is available. */
export function pageOffset(page: number, pageSize = PAGE_SIZE): number {
  return Math.max(0, (page - 1) * pageSize);
}

export interface ResultSummaryInput {
  /** Items on the page as rendered — not the server's total. */
  shown: number;
  /** Favorites are a local view of stored snapshots, not a paged server result. */
  favoriteMode: boolean;
  currentPage: number;
  totalPages: number;
  /** A failed load renders an error in place of results. */
  errorMessage?: string;
}

export interface ResultSummary {
  count: string;
  label: string;
  /** Whether the "more results exist" hint is hidden. */
  moreHidden: boolean;
}

/**
 * The counter above the results.
 *
 * The count is what is on screen now, so "more available" is a separate signal rather than a
 * larger number: reporting a total the page is not showing reads as a rendering bug. Favorites are
 * never paged — the whole stored set is in the browser — so the hint is suppressed there, as it is
 * when an error replaced the results entirely.
 */
export function resultSummary({
  shown,
  favoriteMode,
  currentPage,
  totalPages,
  errorMessage = "",
}: ResultSummaryInput): ResultSummary {
  return {
    count: String(shown),
    label: favoriteMode ? "件のお気に入り" : "件を表示中",
    moreHidden: Boolean(favoriteMode || errorMessage || currentPage >= totalPages),
  };
}
