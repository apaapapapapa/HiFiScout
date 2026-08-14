import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from "./config.js";
import { listShopStates } from "./db/shop-state-repository.js";
import { SHOP_PLUGINS } from "./crawler/shops/index.js";
import { isTransportConfigured } from "./crawler/transport.js";
import type {
  ShopHealthEntry,
  ShopHealthReason,
  ShopHealthStatus,
  ShopHealthSummary,
  SyncHealthResponse,
} from "./api/contracts.js";
import type { CrawlerEnv, ShopPlugin } from "./crawler/types.js";
import type { QueryableDatabase, ShopSyncStateRow } from "./db/types.js";

/**
 * The health vocabulary is part of the `/api/health` and `/api/meta` contracts, so it is owned
 * by `api/contracts.ts`; these aliases keep the existing internal names.
 */
export type SyncHealthStatus = ShopHealthStatus;

export type SyncHealthReason = ShopHealthReason;

/**
 * A `shop_sync_state` row as the health check reads it: every column except `shop_key` is
 * optional so partially populated fixtures and freshly seeded rows are both accepted.
 */
export type ShopSyncStateSnapshot = Partial<ShopSyncStateRow> & { shop_key: string };

export type ShopSyncHealth = ShopHealthSummary;

export interface EvaluateShopSyncHealthOptions {
  state?: Partial<ShopSyncStateRow> | null;
  intervalMinutes: number;
  enabled?: boolean;
  configured?: boolean;
  now?: Date;
  warningFactor?: number;
  criticalFactor?: number;
}

export type ShopSyncHealthEntry = ShopHealthEntry;

export type SyncHealthReport = SyncHealthResponse;

/** `getSyncHealth` reads persisted state, so the database binding is required. */
export interface SyncHealthEnv extends CrawlerEnv {
  readonly DB: QueryableDatabase;
}

const SEVERITY: Record<SyncHealthStatus, number> = {
  disabled: 0,
  healthy: 1,
  warning: 2,
  critical: 3,
};

export function evaluateShopSyncHealth({
  state,
  intervalMinutes,
  enabled = true,
  configured = true,
  now = new Date(),
  warningFactor = 2,
  criticalFactor = 6,
}: EvaluateShopSyncHealthOptions): ShopSyncHealth {
  if (!enabled) return { status: "disabled", ageMinutes: null, reason: "disabled" };
  if (!configured) return { status: "critical", ageMinutes: null, reason: "configuration_missing" };

  const failures = Number(state?.consecutive_failures || 0);
  if (!state?.last_success_at) {
    return {
      status: failures >= 3 ? "critical" : "warning",
      ageMinutes: null,
      reason: failures >= 3 ? "never_succeeded_repeated_failures" : "never_succeeded",
    };
  }

  const lastSuccess = new Date(state.last_success_at);
  const ageMinutes = Number.isFinite(lastSuccess.getTime())
    ? Math.max(0, (now.getTime() - lastSuccess.getTime()) / 60_000)
    : Number.POSITIVE_INFINITY;

  if (failures >= 3 || ageMinutes > intervalMinutes * criticalFactor) {
    return {
      status: "critical",
      ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      reason: failures >= 3 ? "repeated_failures" : "sync_stale",
    };
  }
  if (failures >= 1 || ageMinutes > intervalMinutes * warningFactor) {
    return {
      status: "warning",
      ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      reason: failures >= 1 ? "recent_failure" : "sync_delayed",
    };
  }
  return { status: "healthy", ageMinutes: Math.round(ageMinutes), reason: "ok" };
}

/**
 * Only shops that declare `transportConfigurationRequired` are graded on configuration.
 *
 * For every other collector a missing transport shows up as a failed run in its persisted sync
 * state, so pre-emptively reporting critical would raise an alarm the run itself will raise.
 */
function isShopConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {
  if (!plugin.definition.transportConfigurationRequired) return true;
  return isTransportConfigured(env, plugin);
}

export function buildSyncHealth(
  env: CrawlerEnv,
  stateRows: readonly ShopSyncStateSnapshot[] = [],
  now = new Date(),
): SyncHealthReport {
  const settings = getCrawlerSettings(env);
  const states = new Map(
    stateRows.map((row): [string, ShopSyncStateSnapshot] => [row.shop_key, row]),
  );
  const shops = SHOP_PLUGINS.map((plugin): ShopSyncHealthEntry => {
    const shop = plugin.definition;
    const enabled = getShopEnabled(env, shop);
    const configured = isShopConfigured(env, plugin);
    const intervalMinutes = getShopIntervalMinutes(env, shop);
    const state = states.get(shop.key) || null;
    const health = evaluateShopSyncHealth({
      state,
      intervalMinutes,
      enabled,
      configured,
      now,
      warningFactor: settings.healthWarningFactor,
      criticalFactor: settings.healthCriticalFactor,
    });
    const lastItemCount = Number(state?.last_item_count);
    return {
      shopKey: shop.key,
      name: shop.name,
      enabled,
      configured,
      intervalMinutes,
      lastSuccessAt: state?.last_success_at || null,
      lastAttemptAt: state?.last_attempt_at || null,
      lastItemCount: Number.isFinite(lastItemCount) ? lastItemCount : null,
      consecutiveFailures: Number(state?.consecutive_failures || 0),
      lastError: state?.last_error || null,
      ...health,
    };
  });

  const active = shops.filter((shop) => shop.enabled);
  const status = active.reduce<SyncHealthStatus>(
    (worst, shop) => (SEVERITY[shop.status] > SEVERITY[worst] ? shop.status : worst),
    "healthy",
  );
  return {
    ok: status !== "critical",
    status,
    checkedAt: now.toISOString(),
    shops,
  };
}

export async function getSyncHealth(
  env: SyncHealthEnv,
  now = new Date(),
): Promise<SyncHealthReport> {
  return buildSyncHealth(env, await listShopStates(env.DB), now);
}

export function logSyncHealth(health: SyncHealthReport): void {
  if (health.status === "critical") {
    console.error(JSON.stringify({ event: "sync_health_critical", ...health }));
  } else if (health.status === "warning") {
    console.warn(JSON.stringify({ event: "sync_health_warning", ...health }));
  }
}
