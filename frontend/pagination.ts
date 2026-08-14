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
