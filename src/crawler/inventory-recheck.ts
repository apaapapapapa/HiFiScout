/**
 * Single-listing inventory recheck.
 *
 * Listing pages only say a product exists; whether it is still purchasable has to be read from
 * its detail page. One candidate is rechecked per successful crawl, and a listing is only
 * deactivated after repeated unavailable observations — a transient relay or upstream failure
 * must never look like a sold-out product.
 *
 * Nothing here is shop-specific: the settings come from the shop's own env prefix, and the URL
 * guard and availability classifier from the plugin's inventory-recheck capability.
 */

import { decideInventoryState } from "../inventory/state.js";
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
import { saveSellerDetailOfferFacts } from "../db/seller-detail-offer-repository.js";
import type { InventoryRecheckCandidateRow, QueryableDatabase } from "../db/types.js";
import type {
  CrawlerEnv,
  InventoryRecheckListing,
  InventoryRecheckResult,
  InventoryRecheckSettings,
  RelayPage,
  RelayPageOptions,
  ShopPlugin,
} from "./types.js";

interface InventoryRecheckEnv extends CrawlerEnv {
  DB: QueryableDatabase;
}

interface InventoryRepository {
  selectInventoryRecheckCandidate(
    db: QueryableDatabase,
    shopKey: string,
    window: { staleBefore: string; retryBefore: string; candidateUrlPrefix: string },
  ): Promise<InventoryRecheckCandidateRow | null>;
  markInventoryCheckAttempt(
    db: QueryableDatabase,
    productId: number,
    attemptedAt: string,
    candidate?: InventoryRecheckCandidateRow,
  ): Promise<unknown>;
  markInventoryAvailable(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
    candidate?: InventoryRecheckCandidateRow,
  ): Promise<unknown>;
  markInventoryAmbiguous(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
    candidate?: InventoryRecheckCandidateRow,
  ): Promise<unknown>;
  recordInventoryUnavailable(
    db: QueryableDatabase,
    productId: number,
    checkedAt: string,
    failureCount: number,
    deactivate: boolean,
    evidence?: "missing" | "sold",
    candidate?: InventoryRecheckCandidateRow,
  ): Promise<unknown>;
}

interface InventoryRecheckOptions {
  expectedCandidate?: InventoryRecheckCandidateRow;
  saveDetailFacts?: typeof saveSellerDetailOfferFacts;
  now?: Date;
  fetchFn?: typeof fetch;
  fetchPage?: (url: string, options: RelayPageOptions) => Promise<RelayPage>;
  repository?: InventoryRepository;
}

export type InventoryRecheckPreparation =
  | {
      status: "ready";
      targetUrl: string;
      candidate: InventoryRecheckCandidateRow;
      userAgent: string;
      requestDelayMs: number;
    }
  | { status: "skipped"; reason: "disabled" | "no_candidate" | "invalid_detail_url" };

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

function inventoryDecision(
  candidate: InventoryRecheckCandidateRow,
  latest: "sold_out" | "missing" | "in_stock" | "unknown",
  observedAt: string,
  failureThreshold: number,
) {
  return decideInventoryState({
    stockStatus: candidate.stock_status,
    lastSeenAt: candidate.last_seen_at,
    lastCheckedAt: candidate.last_inventory_checked_at,
    lastConfirmedAvailableAt: candidate.last_confirmed_available_at ?? null,
    failureCount: candidate.inventory_check_failures,
    latest,
    observedAt,
    failureThreshold,
  });
}

function noChange(result: unknown): boolean {
  return isRecord(result) && isRecord(result.meta) && result.meta.changes === 0;
}
function candidateChanged(candidate: InventoryRecheckCandidateRow): InventoryRecheckResult {
  return {
    status: "deferred",
    reason: "candidate_changed",
    productId: candidate.id,
    sourceId: candidate.source_id,
  };
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

async function inventoryCandidate(
  env: InventoryRecheckEnv,
  plugin: ShopPlugin,
  now: Date,
  repository: InventoryRepository,
): Promise<InventoryRecheckCandidateRow | null> {
  const settings = getShopInventoryRecheckSettings(env, plugin.definition);
  return repository.selectInventoryRecheckCandidate(env.DB, plugin.key, {
    staleBefore: isoBefore(now, settings.minListingAgeHours),
    retryBefore: isoBefore(now, settings.intervalHours),
    candidateUrlPrefix: plugin.capabilities.inventoryRecheck?.candidateUrlPrefix ?? "",
  });
}

/**
 * Resolves the exact detail URL that the scheduler must pace before inventory recheck.
 *
 * This is intentionally read-only: no attempt timestamp is changed until the later FETCH alarm
 * actually invokes {@link recheckShopInventory}. A crash between PREPARE and FETCH therefore leaves
 * the same candidate eligible and lets the Durable Object resume from its stored permit.
 */
export async function prepareShopInventoryRecheck(
  env: InventoryRecheckEnv,
  plugin: ShopPlugin,
  {
    now = new Date(),
    repository = defaultRepository,
  }: Pick<InventoryRecheckOptions, "now" | "repository"> = {},
): Promise<InventoryRecheckPreparation> {
  const policy = plugin.capabilities.inventoryRecheck;
  if (!policy) return { status: "skipped", reason: "disabled" };
  const settings = getShopInventoryRecheckSettings(env, plugin.definition);
  if (!settings.enabled) return { status: "skipped", reason: "disabled" };

  const candidate = await inventoryCandidate(env, plugin, now, repository);
  if (!candidate) return { status: "skipped", reason: "no_candidate" };
  if (!policy.isDetailUrl(candidate.source_url)) {
    return { status: "skipped", reason: "invalid_detail_url" };
  }

  const crawlerSettings = getCrawlerSettings(env);
  return {
    status: "ready",
    targetUrl: candidate.source_url,
    candidate,
    userAgent: crawlerSettings.userAgent,
    requestDelayMs: getShopRequestDelayMs(env, plugin.definition, crawlerSettings.requestDelayMs),
  };
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
  const decision = inventoryDecision(
    candidate,
    evidence === "sold" ? "sold_out" : "missing",
    attemptedAt,
    settings.failureThreshold,
  );
  if (decision.action === "defer")
    return {
      status: "deferred",
      reason: "stale_observation",
      productId: candidate.id,
      sourceId: candidate.source_id,
    };
  const failureCount = decision.failureCount;
  const deactivate = decision.action === "deactivate_confirmed";
  const written = await repository.recordInventoryUnavailable(
    env.DB,
    candidate.id,
    attemptedAt,
    failureCount,
    deactivate,
    evidence,
    candidate,
  );
  if (noChange(written)) return candidateChanged(candidate);
  return {
    stateChanged: deactivate || decision.stockStatus !== candidate.stock_status,
    decisionReason: decision.reason,
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
 * callers can invoke it unconditionally. A Durable Object may inject `fetchPage` after a
 * PREPARE/Alarm/FETCH handshake; the legacy Queue path still constructs the Relay transport here.
 */
export async function recheckShopInventory(
  env: InventoryRecheckEnv,
  plugin: ShopPlugin,
  {
    now = new Date(),
    fetchFn = fetch,
    fetchPage,
    repository = defaultRepository,
    saveDetailFacts = saveSellerDetailOfferFacts,
    expectedCandidate,
  }: InventoryRecheckOptions = {},
): Promise<InventoryRecheckResult> {
  const policy = plugin.capabilities.inventoryRecheck;
  if (!policy) return { status: "skipped", reason: "disabled" };
  const settings = getShopInventoryRecheckSettings(env, plugin.definition);
  if (!settings.enabled) return { status: "skipped", reason: "disabled" };
  // The built-in fetcher is the Relay; a direct shop is only ever rechecked through a page fetched
  // under the Durable Object's prepared permit.
  if (!fetchPage && plugin.capabilities.transport?.kind !== "relay")
    return { status: "skipped", reason: "disabled" };

  const attemptedAt = now.toISOString();

  try {
    const candidate = expectedCandidate ?? (await inventoryCandidate(env, plugin, now, repository));
    if (!candidate) return { status: "skipped", reason: "no_candidate" };

    const claim = await repository.markInventoryCheckAttempt(
      env.DB,
      candidate.id,
      attemptedAt,
      candidate,
    );
    if (noChange(claim)) return candidateChanged(candidate);

    if (!policy.isDetailUrl(candidate.source_url)) {
      return {
        status: "deferred",
        reason: "invalid_detail_url",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    const crawlerSettings = getCrawlerSettings(env);
    const requestDelayMs = getShopRequestDelayMs(
      env,
      plugin.definition,
      crawlerSettings.requestDelayMs,
    );

    let page;
    try {
      if (fetchPage) {
        page = await fetchPage(candidate.source_url, {
          userAgent: crawlerSettings.userAgent,
          requestDelayMs,
        });
      } else {
        const { relayUrl, relayToken } = relayConfiguration(env);
        const relay = createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn });
        if (!relay.fetchPage) throw new Error("relay_fetch_page_unavailable");
        page = await relay.fetchPage(candidate.source_url, {
          userAgent: crawlerSettings.userAgent,
          requestDelayMs,
        });
      }
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
      if (
        !page.finalUrl ||
        !(
          policy.isEvidenceUrl?.(candidate.source_url, page.finalUrl) ??
          candidate.source_url === page.finalUrl
        )
      )
        return {
          status: "deferred",
          reason: "missing_identity_unverified",
          productId: candidate.id,
          sourceId: candidate.source_id,
        };
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

    if (policy.isChallengePage?.(page.body))
      return {
        status: "deferred",
        reason: "verification_challenge",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    const listing: InventoryRecheckListing = {
      sourceId: candidate.source_id,
      sourceUrl: candidate.source_url,
      title: candidate.title,
      model: candidate.model,
    };
    // Facts are saved even when availability stays ambiguous, so they need the same identity.
    const facts = policy.extractOfferFacts?.(page.body, attemptedAt, listing);

    const classification = policy.classifyPage(page.body, listing);
    const decision = inventoryDecision(
      candidate,
      classification,
      attemptedAt,
      settings.failureThreshold,
    );
    if (decision.action === "defer")
      return {
        status: "deferred",
        reason: "stale_observation",
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    if (decision.reason === "confirmed_available") {
      const written = await repository.markInventoryAvailable(
        env.DB,
        candidate.id,
        attemptedAt,
        candidate,
      );
      if (noChange(written)) return candidateChanged(candidate);
      if (facts != null) await saveDetailFacts(env.DB, candidate.id, facts);
      return {
        status: "checked",
        outcome: "in_stock",
        stateChanged: decision.stockStatus !== candidate.stock_status,
        decisionReason: decision.reason,
        productId: candidate.id,
        sourceId: candidate.source_id,
      };
    }

    if (classification === "sold_out") {
      const result = await recordUnavailable(
        repository,
        env,
        candidate,
        attemptedAt,
        settings,
        "sold",
        200,
      );
      if (result.status === "checked" && facts != null)
        await saveDetailFacts(env.DB, candidate.id, facts);
      return result;
    }

    const written = await repository.markInventoryAmbiguous(
      env.DB,
      candidate.id,
      attemptedAt,
      candidate,
    );
    if (noChange(written)) return candidateChanged(candidate);
    if (facts != null) await saveDetailFacts(env.DB, candidate.id, facts);
    return {
      status: "checked",
      outcome: "ambiguous",
      stateChanged: decision.stockStatus !== candidate.stock_status,
      decisionReason: decision.reason,
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
