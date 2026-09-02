import { getCrawlerSettings, getShopEnabled, getShopIntervalMinutes } from "../config.js";
import {
  clearShopDispatch,
  getShopState,
  listShopStates,
  markShopDispatchSent,
  releaseShopDispatch,
  reserveShopDispatch,
} from "../db/shop-state-repository.js";
import {
  hasDispatchReservation,
  shouldRecoverDispatch,
  type CrawlDispatchStateRow,
} from "./crawl-lifecycle.js";
import { deliverCrawlDispatch, type CrawlDispatchMessage } from "./orchestration.js";
import { isShopDue } from "./run.js";
import { getShopPlugin, SHOP_PLUGINS } from "./shops/index.js";
import { isTransportConfigured } from "./transport.js";
import type { QueryableDatabase, ShopSyncStateRow } from "../db/types.js";
import type { CrawlerEnv, DispatchResult, DueDispatchCandidate, ShopPlugin } from "./types.js";

type RuntimeEnv = CrawlerEnv & { DB: QueryableDatabase };

interface DispatchOptions {
  now?: Date;
  excludeShopKeys?: string[];
}

interface DispatchAtOptions {
  now?: Date;
}

interface RecoveryOptions {
  now?: Date;
  recoveryMinutes?: number;
}

function isConfigured(env: CrawlerEnv, plugin: ShopPlugin): boolean {
  return isTransportConfigured(env, plugin.capabilities.transport?.kind);
}

/** A logical dispatch remains reserved until the owning Durable Object reaches a terminal state. */
export function isDispatchReservationActive(state: ShopSyncStateRow | null | undefined): boolean {
  return hasDispatchReservation(state as CrawlDispatchStateRow | null | undefined);
}

export function dueDispatchCandidates(
  env: CrawlerEnv,
  stateRows: readonly ShopSyncStateRow[] = [],
  now = new Date(),
  { excludeShopKeys = [] }: Pick<DispatchOptions, "excludeShopKeys"> = {},
): DueDispatchCandidate[] {
  const states = new Map(stateRows.map((row) => [row.shop_key, row]));
  const excluded = new Set(excludeShopKeys);
  return SHOP_PLUGINS.map((plugin) => {
    if (excluded.has(plugin.key)) return null;
    const definition = plugin.definition;
    const state = states.get(plugin.key) || null;
    if (!getShopEnabled(env, definition)) return null;
    if (!isConfigured(env, plugin)) return null;
    const intervalMinutes = getShopIntervalMinutes(env, definition);
    if (!isShopDue(state, intervalMinutes, now)) return null;
    if (isDispatchReservationActive(state)) return null;
    return { adapter: plugin, state, lastAttempt: state?.last_attempt_at || "" };
  })
    .filter((candidate): candidate is DueDispatchCandidate => candidate !== null)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
}

export async function clearDispatch(db: QueryableDatabase, shopKey: string): Promise<void> {
  return clearShopDispatch(db, shopKey);
}

async function dispatchReservedCrawl(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  force: boolean,
  requestedAt: string,
  batchRunId: string,
  recoveryMinutes: number,
): Promise<boolean> {
  const dispatchToken = await reserveShopDispatch(env.DB, plugin.key, requestedAt, recoveryMinutes);
  if (!dispatchToken) return false;

  const message: CrawlDispatchMessage = {
    shopKey: plugin.key,
    force,
    requestedAt,
    jobId: dispatchToken,
    batchRunId,
  };
  try {
    await deliverCrawlDispatch(env as unknown as Env, message);
    return true;
  } catch (error) {
    await releaseShopDispatch(env.DB, plugin.key, dispatchToken);
    throw error;
  }
}

function newBatchRunId(requestedAt: string): string {
  return `crawl-batch:${requestedAt}:${crypto.randomUUID()}`;
}

function logBatchDispatch(
  batchRunId: string,
  requestedAt: string,
  dispatched: readonly string[],
  candidates: readonly DueDispatchCandidate[],
): void {
  console.log(
    JSON.stringify({
      event: "crawl_batch_dispatched",
      transport: "durable_object",
      batchRunId,
      requestedAt,
      candidateCount: candidates.length,
      dispatchedCount: dispatched.length,
      dispatched,
    }),
  );
}

/** Re-deliver a quiet logical child to the same per-shop Durable Object using the same token. */
export async function recoverStalledCrawlDispatches(
  env: RuntimeEnv,
  {
    now = new Date(),
    recoveryMinutes = getCrawlerSettings(env).dispatchLeaseMinutes,
  }: RecoveryOptions = {},
): Promise<string[]> {
  const recovered: string[] = [];
  const states = (await listShopStates(env.DB)) as CrawlDispatchStateRow[];
  const recoveredAt = now.toISOString();
  const batchRunId = `crawl-recovery:${recoveredAt}:${crypto.randomUUID()}`;

  for (const state of states) {
    if (!shouldRecoverDispatch(state, now, recoveryMinutes) || !state.dispatch_requested_at)
      continue;
    const plugin = getShopPlugin(state.shop_key);
    if (!plugin || !getShopEnabled(env, plugin.definition) || !isConfigured(env, plugin)) continue;
    if (!state.dispatch_token) continue;

    const message: CrawlDispatchMessage = {
      shopKey: plugin.key,
      force: true,
      requestedAt: state.dispatch_requested_at,
      jobId: state.dispatch_token,
      batchRunId,
    };

    try {
      const transport = await deliverCrawlDispatch(env as unknown as Env, message);
      await markShopDispatchSent(env.DB, plugin.key, state.dispatch_token, recoveredAt);
      recovered.push(plugin.key);
      console.warn(
        JSON.stringify({
          event: "crawl_dispatch_recovered",
          shopKey: plugin.key,
          requestedAt: state.dispatch_requested_at,
          recoveredAt,
          jobId: state.dispatch_token,
          batchRunId,
          transport,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "crawl_dispatch_recovery_failed",
          shopKey: plugin.key,
          requestedAt: state.dispatch_requested_at,
          jobId: state.dispatch_token,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  return recovered;
}

export async function dispatchDueCrawls(
  env: RuntimeEnv,
  { now = new Date(), excludeShopKeys = [] }: DispatchOptions = {},
): Promise<DispatchResult> {
  const settings = getCrawlerSettings(env);
  await recoverStalledCrawlDispatches(env, {
    now,
    recoveryMinutes: settings.dispatchLeaseMinutes,
  });
  const candidates = dueDispatchCandidates(env, await listShopStates(env.DB), now, {
    excludeShopKeys,
  });
  const dispatchedAt = now.toISOString();
  const batchRunId = newBatchRunId(dispatchedAt);
  const dispatched: string[] = [];

  for (const { adapter } of candidates) {
    const reserved = await dispatchReservedCrawl(
      env,
      adapter,
      false,
      dispatchedAt,
      batchRunId,
      settings.dispatchLeaseMinutes,
    );
    if (reserved) dispatched.push(adapter.key);
  }

  logBatchDispatch(batchRunId, dispatchedAt, dispatched, candidates);
  return dispatched.length
    ? { status: "queued", queued: dispatched }
    : { status: "skipped", queued: dispatched };
}

async function dispatchOneCrawl(
  env: RuntimeEnv,
  plugin: ShopPlugin,
  force: boolean,
  now: Date,
): Promise<DispatchResult> {
  const state = await getShopState(env.DB, plugin.key);
  const settings = getCrawlerSettings(env);
  if (isDispatchReservationActive(state)) {
    return { status: "skipped", reason: "dispatch_lease_active", shopKey: plugin.key };
  }

  const dispatchedAt = now.toISOString();
  const batchRunId = newBatchRunId(dispatchedAt);
  const reserved = await dispatchReservedCrawl(
    env,
    plugin,
    force,
    dispatchedAt,
    batchRunId,
    settings.dispatchLeaseMinutes,
  );
  console.log(
    JSON.stringify({
      event: "crawl_batch_dispatched",
      transport: "durable_object",
      batchRunId,
      requestedAt: dispatchedAt,
      candidateCount: 1,
      dispatchedCount: reserved ? 1 : 0,
      dispatched: reserved ? [plugin.key] : [],
    }),
  );
  return reserved
    ? { status: "queued", shopKey: plugin.key }
    : { status: "skipped", reason: "dispatch_lease_active", shopKey: plugin.key };
}

export async function dispatchScheduledCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };
  return dispatchOneCrawl(env, plugin, true, now);
}

export async function dispatchForcedCrawl(
  env: RuntimeEnv,
  shopKey: string | null | undefined,
  { now = new Date() }: DispatchAtOptions = {},
): Promise<DispatchResult> {
  const plugin = getShopPlugin(shopKey);
  if (!plugin) return { status: "rejected", reason: "unknown_shop" };
  if (!getShopEnabled(env, plugin.definition)) return { status: "rejected", reason: "disabled" };
  if (!isConfigured(env, plugin)) return { status: "rejected", reason: "configuration_missing" };
  return dispatchOneCrawl(env, plugin, true, now);
}
