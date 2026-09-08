import { getShopEnabled } from "../config.js";
import { listShopStates, getShopState } from "../db/shop-state-repository.js";
import type { CrawlDispatchStateRow } from "./crawl-lifecycle.js";
import { dispatchForcedCrawl } from "./dispatch.js";
import { deliverCrawlDispatch } from "./orchestration.js";
import { isCrawlQuietHours, nextCrawlAllowedAt } from "./crawl-window.js";
import { dailyRotationShopForScheduledTime, shopForCronAtScheduledTime } from "./schedule.js";
import { SHOP_PLUGINS, getShopPlugin } from "./shops/index.js";
import { isTransportConfigured } from "./transport.js";
import type { AdminCrawlOverview, AdminCrawlStatus } from "../api/admin-listing-contracts.js";

function cronFieldMatches(field: string, value: number): boolean {
  return field.split(",").some((part) => {
    if (part === "*") return true;
    if (!/^\d+(?:-\d+)?$/u.test(part)) return false;
    const [start, end = start] = part.split("-").map(Number);
    return start <= value && value <= end;
  });
}

/** Derive the next daily/dedicated slot from the same registry selectors as cron dispatch. */
export function nextAdminCrawlSchedules(now: Date): Map<string, string> {
  const result = new Map<string, string>();
  const crons = [
    ...new Set(SHOP_PLUGINS.map((p) => p.definition.scheduleCron).filter((c): c is string => !!c)),
  ];
  const start = Math.floor(now.getTime() / 60_000) * 60_000;
  for (let offset = 1; offset <= 48 * 60 && result.size < SHOP_PLUGINS.length; offset++) {
    const date = new Date(start + offset * 60_000);
    if (isCrawlQuietHours(date.getTime())) continue;
    const remember = (key: string | undefined) => {
      if (key && !result.has(key)) result.set(key, date.toISOString());
    };
    if (date.getUTCMinutes() % 10 === 0) remember(dailyRotationShopForScheduledTime(date)?.key);
    for (const cron of crons) {
      const [minute, hour, ...calendar] = cron.split(" ");
      // Unsupported future calendars remain unknown rather than inventing a schedule.
      if (
        calendar.length === 3 &&
        calendar.every((c) => c === "*") &&
        cronFieldMatches(minute, date.getUTCMinutes()) &&
        cronFieldMatches(hour, date.getUTCHours())
      )
        remember(shopForCronAtScheduledTime(cron, date)?.key);
    }
  }
  return result;
}

async function scheduler(
  env: Env,
  shopKey: string,
  action?: "pause" | "resume" | "wake",
): Promise<AdminCrawlStatus> {
  const stub = env.CRAWL_SCHEDULER.get(env.CRAWL_SCHEDULER.idFromName(shopKey));
  const response = await stub.fetch(
    `https://crawl-scheduler.internal/admin/${action ? "control" : "status"}`,
    action
      ? {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ shopKey, action }),
        }
      : undefined,
  );
  if (!response.ok) throw new Error(`scheduler_status_${response.status}`);
  return response.json<AdminCrawlStatus>();
}

export async function readAdminCrawls(env: Env): Promise<AdminCrawlOverview> {
  const now = new Date();
  const states = new Map((await listShopStates(env.DB)).map((s) => [s.shop_key, s]));
  const schedules = nextAdminCrawlSchedules(now);
  const items: AdminCrawlOverview["items"] = [];
  // Bound concurrent DO reads; none of them read the listing inventory or D1 history.
  for (let offset = 0; offset < SHOP_PLUGINS.length; offset += 4) {
    items.push(
      ...(await Promise.all(
        SHOP_PLUGINS.slice(offset, offset + 4).map(async (plugin) => {
          const state = states.get(plugin.key);
          let control: AdminCrawlStatus | null = null;
          let error: string | null = null;
          try {
            control = await scheduler(env, plugin.key);
          } catch {
            error = "実行状態を取得できません。再読み込みしてください。";
          }
          return {
            shopKey: plugin.key,
            name: plugin.definition.name,
            enabled: getShopEnabled(env, plugin.definition),
            configured: isTransportConfigured(env, plugin.capabilities.transport?.kind),
            pausedIntent: !!state?.admin_paused,
            lastSuccessAt: state?.last_success_at ?? null,
            lastAttemptAt: state?.last_attempt_at ?? null,
            lastError: state?.last_error ?? null,
            lastErrorAt: state?.last_error_at ?? null,
            consecutiveFailures: state?.consecutive_failures ?? 0,
            backoffUntil: state?.backoff_until ?? null,
            lastItemCount: state?.last_success_at ? state.last_item_count : null,
            previousItemCount: state?.previous_item_count ?? null,
            nextScheduledAt: schedules.get(plugin.key) ?? null,
            lastProjectionAt: state?.last_projection_at ?? null,
            control,
            error,
          };
        }),
      )),
    );
  }
  return {
    observedAt: now.toISOString(),
    quietHours: isCrawlQuietHours(now.getTime()),
    quietEndsAt: isCrawlQuietHours(now.getTime())
      ? new Date(nextCrawlAllowedAt(now.getTime())).toISOString()
      : null,
    items,
  };
}

export async function controlAdminCrawl(
  env: Env,
  shopKey: string,
  action: "pause" | "resume" | "run",
) {
  const plugin = getShopPlugin(shopKey);
  if (!plugin || !["pause", "resume", "run"].includes(action))
    throw new Error("invalid_crawl_control");
  if (action !== "run") {
    await scheduler(env, shopKey, action);
    return {
      message:
        action === "pause"
          ? "一時停止しました。実行中の1ステップは完了する場合があります。"
          : "一時停止を解除しました。保留中の実行または次回予定から再開します。",
    };
  }
  if (
    !getShopEnabled(env, plugin.definition) ||
    !isTransportConfigured(env, plugin.capabilities.transport?.kind)
  )
    return { message: "このショップは無効または接続設定がありません。" };
  const control = await scheduler(env, shopKey, "wake");
  if (control.paused) return { message: "一時停止を解除してから実行してください。" };
  if (control.running)
    return { message: "保留中の実行を継続します。夜間停止と店舗ごとの待機時間を守ります。" };
  const state = (await getShopState(env.DB, shopKey)) as CrawlDispatchStateRow | null;
  if (state?.admin_paused)
    return { message: "一時停止の設定が残っています。再開操作をもう一度実行してください。" };
  if (state?.dispatch_token && state.dispatch_requested_at) {
    await deliverCrawlDispatch(env, {
      shopKey,
      requestedAt: state.dispatch_requested_at,
      jobId: state.dispatch_token,
      force: true,
    });
    return { message: "同じ実行IDで復旧を予約しました。夜間停止中は朝8時以降に再開します。" };
  }
  const result = await dispatchForcedCrawl(env, shopKey);
  return {
    message:
      result.status === "queued"
        ? "再実行を予約しました。"
        : result.status === "skipped" && result.reason === "crawl_quiet_hours"
          ? "夜間の予定停止中です。朝8時以降に実行してください。"
          : "新しい実行は開始しませんでした。最新の状態を確認してください。",
  };
}
