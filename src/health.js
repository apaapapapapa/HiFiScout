import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from './config.js';
import { listShopStates } from './db/shop-state-repository.js';
import { SHOP_PLUGINS } from './crawler/shops/index.js';
import { isTransportConfigured } from './crawler/transport.js';

const SEVERITY = { disabled: 0, healthy: 1, warning: 2, critical: 3 };

export function evaluateShopSyncHealth({
  state,
  intervalMinutes,
  enabled = true,
  configured = true,
  now = new Date(),
  warningFactor = 2,
  criticalFactor = 6
}) {
  if (!enabled) return { status: 'disabled', ageMinutes: null, reason: 'disabled' };
  if (!configured) return { status: 'critical', ageMinutes: null, reason: 'configuration_missing' };

  const failures = Number(state?.consecutive_failures || 0);
  if (!state?.last_success_at) {
    return {
      status: failures >= 3 ? 'critical' : 'warning',
      ageMinutes: null,
      reason: failures >= 3 ? 'never_succeeded_repeated_failures' : 'never_succeeded'
    };
  }

  const lastSuccess = new Date(state.last_success_at);
  const ageMinutes = Number.isFinite(lastSuccess.getTime())
    ? Math.max(0, (now.getTime() - lastSuccess.getTime()) / 60_000)
    : Number.POSITIVE_INFINITY;

  if (failures >= 3 || ageMinutes > intervalMinutes * criticalFactor) {
    return {
      status: 'critical',
      ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      reason: failures >= 3 ? 'repeated_failures' : 'sync_stale'
    };
  }
  if (failures >= 1 || ageMinutes > intervalMinutes * warningFactor) {
    return {
      status: 'warning',
      ageMinutes: Number.isFinite(ageMinutes) ? Math.round(ageMinutes) : null,
      reason: failures >= 1 ? 'recent_failure' : 'sync_delayed'
    };
  }
  return { status: 'healthy', ageMinutes: Math.round(ageMinutes), reason: 'ok' };
}

function isShopConfigured(env, plugin) {
  if (!isTransportConfigured(env, plugin)) return false;
  if (plugin.transport === 'relay') return true;
  return !plugin.isConfigured || plugin.isConfigured(env);
}

export function buildSyncHealth(env, stateRows = [], now = new Date()) {
  const settings = getCrawlerSettings(env);
  const states = new Map(stateRows.map(row => [row.shop_key, row]));
  const shops = SHOP_PLUGINS.map(plugin => {
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
      criticalFactor: settings.healthCriticalFactor
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
      ...health
    };
  });

  const active = shops.filter(shop => shop.enabled);
  const status = active.reduce((worst, shop) => SEVERITY[shop.status] > SEVERITY[worst] ? shop.status : worst, 'healthy');
  return {
    ok: status !== 'critical',
    status,
    checkedAt: now.toISOString(),
    shops
  };
}

export async function getSyncHealth(env, now = new Date()) {
  return buildSyncHealth(env, await listShopStates(env.DB), now);
}

export function logSyncHealth(health) {
  if (health.status === 'critical') {
    console.error(JSON.stringify({ event: 'sync_health_critical', ...health }));
  } else if (health.status === 'warning') {
    console.warn(JSON.stringify({ event: 'sync_health_warning', ...health }));
  }
}
