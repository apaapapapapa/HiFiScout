/**
 * Single-listing inventory recheck.
 *
 * Listing pages only say a product exists; whether it is still purchasable has to be read from
 * its detail page. One candidate is rechecked per successful crawl, and a listing is only
 * deactivated after repeated unavailable observations — a transient relay or upstream failure
 * must never look like a sold-out product.
 *
 * Nothing here is shop-specific: the URL guard, the availability classifier and the settings
 * names all come from the adapter's {@link InventoryRecheckPolicy}.
 */

import {
  getCrawlerSettings,
  getShopInventoryRecheckSettings,
  getShopRequestDelayMs,
} from "../config.js";
import {
  markInventoryAmbiguous,
  markInventoryAvailable,
  markInventoryCheckAttempt,
  recordInventoryUnavailable,
  selectInventoryRecheckCandidate,
} from "../db/inventory-recheck-repository.js";
import { createRelayHtmlFetcher } from "./relay.js";
import { relayConfiguration } from "./transport.js";
import { isRecord } from "../types.js";
import type { InventoryRecheckCandidateRow, QueryableDatabase } from "../db/types.js";
import type {
  CrawlerEnv,
  InventoryRecheckResult,
  InventoryRecheckSettings,
  ShopPlugin,
} from "./types.js";

interface InventoryRecheckEnv extends CrawlerEnv {
  DB: QueryableDatabase;
}

interface InventoryRepository {
  selectInventoryRecheckCandidate(
    db: QueryableDatabase,
    shopKey: string,
    window: { staleBefore: string; retryBefore: string },
  ): Promise<InventoryRecheckCandidateRow | null>;
  markInventoryCheckAttempt(
    db: QueryableDatabase,
    productId: number,
    attemptedAt: string,
  ): Promise<unknown>;
  markInventoryAvailable(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
  ): Promise<unknown>;
  markInventoryAmbiguous(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
  ): Promise<unknown>;
  recordInventoryUnavailable(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
    failureCount: number,
    deactivate: boolean,
  ): Promise<unknown>;
}

interface InventoryRecheckOptions {
  now?: Date;
  fetchFn?: typeof fetch;
  repository?: InventoryRepository;
}

const defaultRepository = {
  selectInventoryRecheckCandidate,
  markInventoryCheckAttempt,
  markInventoryAvailable,
  markInventoryAmbiguous,
  recordInventoryUnavailable,
};

function isoBefore(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function priorUnavailableFailures(candidate: InventoryRecheckCandidateRow): number {
  const checkedAt = Date.parse(candidate?.last_inventory_checked_at || "");
  const lastSeenAt = Date.parse(candidate?.last_seen_at || "");
  if (!Number.isFinite(checkedAt)) return 0;
  if (Number.isFinite(lastSeenAt) && lastSeenAt > checkedAt) return 0;
  const stored = Number.parseInt(String(candidate?.inventory_check_failures ?? "0"), 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

function relayFailureReason(error: unknown): InventoryRecheckResult["reason"] {
  if (isRecord(error) && error.code === "robots_disallowed") return "robots_disallowed";
  if (
    isRecord(error) &&
    typeof error.relayStatus === "number" &&
    Number.isFinite(error.relayStatus)
  )
    return `relay_http_${error.relayStatus}`;
  return "relay_error";
}

async function recordUnavailable(
  repository: InventoryRepository,
  env: InventoryRecheckEnv,
  candidate: InventoryRecheckCandidateRow,
  attemptedAt: string,
  settings: InventoryRecheckSettings,
  evidence: "missing" | "sold",
  httpStatus: number,
): Promise<InventoryRecheckResult> {
  const failureCount = priorUnavailableFailures(candidate) + 1;
  const deactivate = failureCount >= settings.failureThreshold;
  await repository.recordInventoryUnavailable(
    env.DB,
    candidate.id,
    attemptedAt,
    failureCount,
    deactivate,
  );
  return {
    status: "checked",
    outcome: deactivate ? `${evidence}_deactivated` : `${evidence}_retry`,
    ...(httpStatus ? { httpStatus } : {}),
    failureCount,
    productId: candidate.id,
    sourceId: candidate.source_id,
  };
}

/**
 * Rechecks one stale listing for `plugin`.
 *
 * Returns `{ status: "skipped", reason: "disabled" }` for a shop that declares no policy, so
 * callers can invoke it unconditionally.
 */
export async function recheckShopInventory(
  env: InventoryRecheckEnv,
  plugin: ShopPlugin,
  {
    now = new Date(),
    fetchFn = fetch,
    repository = defaultRepository,
  }: InventoryRecheckOptions = {},
): Promise<InventoryRecheckResult> {
  const policy = plugin.inventoryRecheck;
  if (!policy) return { status: "skipped", reason: "disabled" };
  const settings = getShopInventoryRecheckSettings(env, policy);
  if (!settings.enabled) return { status: "skipped", reason: "disabled" };

  const attemptedAt = now.toISOString();

  try {
    const candidate = await repository.selectInventoryRecheckCandidate(env.DB, plugin.key, {
      staleBefore: isoBefore(now, settings.minListingAgeHours),
      retryBefore: isoBefore(now, settings.intervalHours),
    });
    if (!candidate) return { status: "skipped", reason: "no_candidate" };

    await repository.markInventoryCheckAttempt(env.DB, candidate.id, attemptedAt);

    if (!policy.isDetailUrl(candidate.source_url)) {
      return {
        status: "deferred",
        reason: "invalid_detail_url",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    const { relayUrl, relayToken } = relayConfiguration(env);
    const relay = createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn });
    if (!relay.fetchPage) throw new Error("relay_fetch_page_unavailable");
    const crawlerSettings = getCrawlerSettings(env);
    const requestDelayMs = getShopRequestDelayMs(
      env,
      plugin.definition,
      crawlerSettings.requestDelayMs,
    );

    let page;
    try {
      page = await relay.fetchPage(candidate.source_url, {
        userAgent: crawlerSettings.userAgent,
        requestDelayMs,
      });
    } catch (error) {
      return {
        status: "deferred",
        reason: relayFailureReason(error),
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    const status = Number(page.status);
    if (status === 404 || status === 410) {
      return recordUnavailable(
        repository,
        env,
        candidate,
        attemptedAt,
        settings,
        "missing",
        status,
      );
    }

    if (status === 403 || status === 429 || status >= 500) {
      return {
        status: "deferred",
        reason: `upstream_http_${status}`,
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    if (status !== 200) {
      return {
        status: "deferred",
        reason: `unexpected_http_${status}`,
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    if (
      !String(page.contentType || "")
        .toLowerCase()
        .includes("text/html")
    ) {
      return {
        status: "deferred",
        reason: "unexpected_content_type",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    const classification = policy.classifyPage(page.body);
    if (classification === "in_stock") {
      await repository.markInventoryAvailable(env.DB, candidate.id, attemptedAt);
      return {
        status: "checked",
        outcome: "in_stock",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    if (classification === "sold_out") {
      return recordUnavailable(repository, env, candidate, attemptedAt, settings, "sold", 200);
    }

    await repository.markInventoryAmbiguous(env.DB, candidate.id, attemptedAt);
    return {
      status: "checked",
      outcome: "ambiguous",
      productId: candidate.id,
      sourceId: candidate.source_id,
    };
  } catch (error) {
    return {
      status: "failed",
      reason: "inventory_recheck_error",
      error: String(error instanceof Error ? error.message : error).slice(0, 200),
    };
  }
}
