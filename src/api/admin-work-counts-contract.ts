export const ADMIN_WORK_COUNT_LIMIT = 100;

export interface AdminDuplicateCountCursor {
  bucketKey: string;
  afterId: number;
}

export interface AdminWorkCountsPage {
  reports: number;
  candidates: number;
  /** Refined identities, one per catalog row. Two rows make one duplicate group. */
  duplicateIdentities: string[];
  nextDuplicateCursor: AdminDuplicateCountCursor | null;
}

export function parseAdminWorkCountCursor(url: URL): AdminDuplicateCountCursor | null {
  const bucketKey = url.searchParams.get("afterKey") || "";
  const rawId = url.searchParams.get("afterId") || "0";
  const afterId = Number(rawId);
  if (
    bucketKey.length > 300 ||
    /\p{Cc}/u.test(bucketKey) ||
    !/^\d{1,15}$/u.test(rawId) ||
    !Number.isSafeInteger(afterId) ||
    Boolean(bucketKey) !== afterId > 0
  )
    return null;
  return { bucketKey, afterId };
}
