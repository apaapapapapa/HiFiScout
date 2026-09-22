export const AUCTION_ADMIN_ACTIONS = [
  "status",
  "pause",
  "resume",
  "wake",
  "public_pause",
  "public_resume",
  "retry_failed",
  "clear_halt",
] as const;
export type AuctionAdminAction = (typeof AUCTION_ADMIN_ACTIONS)[number];
export interface AuctionAdminCommand {
  action: AuctionAdminAction;
  categories?: string[];
  reviewed?: true;
}
export function parseAuctionAdminCommand(value: unknown): AuctionAdminCommand | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const b = value as Record<string, unknown>;
  if (
    Object.keys(b).some((key) => !["action", "categories", "reviewed"].includes(key)) ||
    typeof b.action !== "string" ||
    !AUCTION_ADMIN_ACTIONS.includes(b.action as AuctionAdminAction)
  )
    return null;
  if (
    b.categories !== undefined &&
    (!Array.isArray(b.categories) ||
      b.categories.length > 2 ||
      b.categories.some((id) => typeof id !== "string" || !/^\d{1,12}$/u.test(id)))
  )
    return null;
  if (
    (b.reviewed !== undefined && b.reviewed !== true) ||
    (b.action === "clear_halt" && b.reviewed !== true) ||
    (b.action === "status" && (b.categories !== undefined || b.reviewed !== undefined))
  )
    return null;
  return {
    action: b.action as AuctionAdminAction,
    ...(b.categories !== undefined ? { categories: [...new Set(b.categories as string[])] } : {}),
    ...(b.reviewed === true ? { reviewed: true } : {}),
  };
}
export interface AuctionAdminBudget {
  requests: number;
  publicRequests: number;
  sellerRequests: number;
  pages: number;
  newItems: number;
  reads: number;
  writes: number;
  durationGbSeconds: number;
  alarmOperations: number;
}
export interface AuctionAdminStatus {
  observedAt: string;
  state: {
    paused: boolean;
    publicPaused: boolean;
    generation: number;
    categories: string[];
    utcDay: number;
    reserved: AuctionAdminBudget;
    coverage: "partial" | "unknown";
    lastSuccessAt: string | null;
    lastFailure: string | null;
    halt: string | null;
    backoffUntil: number;
    nextFetchAt: number;
  };
  access: { collect: boolean; search: boolean; display: boolean; blockers: string[] };
  limits: {
    retainedItems: number;
    newItemsPerUtcDay: number;
    sellerRequestsPerUtcDay: number;
    listingPagesPerUtcDay: number;
    doRequestsPerUtcDay: number;
    publicRequestsPerUtcDay: number;
    rowsReadPerUtcDay: number;
    rowsWrittenPerUtcDay: number;
    durationGbSecondsPerUtcDay: number;
    alarmOperationsPerUtcDay: number;
    storedBytes: number;
    recoveryReserveRatio: number;
  };
  categories: readonly { id: string; label: string }[];
  nextAlarm: number | null;
  retainedItems: number;
  pendingTasks: number;
  exhaustedTasks: number;
  endCheckPending: number;
  confirmationTasks: number;
  catalogPendingKeys: number;
  catalogNext: number | null;
  catalogError: string | null;
  storageBytes: number;
  quietHours: boolean;
  quietEndsAt: string | null;
  productionUsage: null;
  reservationKind: "conservative_upper_bound";
}
