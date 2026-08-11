import {
  getAudioUnionInventoryRecheckSettings,
  getCrawlerSettings,
  getShopRequestDelayMs,
  SHOP_DEFINITIONS
} from '../config.js';
import {
  markInventoryAmbiguous,
  markInventoryAvailable,
  markInventoryCheckAttempt,
  markInventorySoldOut,
  recordInventoryMissing,
  selectInventoryRecheckCandidate
} from '../db/inventory-recheck-repository.js';
import { createRelayHtmlFetcher } from './relay.js';
import { relayConfiguration } from './transport.js';

const AUDIOUNION_DETAIL_PATH = /^\/ct\/detail\/used\/\d+\/?$/;

const defaultRepository = {
  selectInventoryRecheckCandidate,
  markInventoryCheckAttempt,
  markInventoryAvailable,
  markInventoryAmbiguous,
  markInventorySoldOut,
  recordInventoryMissing
};

function visibleText(html) {
  return String(html || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&yen;|&#165;/gi, '¥')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isAudioUnionUsedDetailUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' &&
      url.hostname === 'www.audiounion.jp' &&
      url.port === '' &&
      url.username === '' &&
      url.password === '' &&
      AUDIOUNION_DETAIL_PATH.test(url.pathname) &&
      url.search === '' &&
      url.hash === '';
  } catch {
    return false;
  }
}

export function classifyAudioUnionInventoryPage(html) {
  const text = visibleText(html);
  if (!text) return 'ambiguous';

  const priceContext = text.match(/販売価格.{0,120}/i)?.[0] || '';
  const hasPricedOffer = /(?:[¥￥]\s*[0-9][0-9,]*|[0-9][0-9,]*\s*円)/.test(priceContext);
  const hasPurchaseEvidence = /在庫あり|カートに入れる|購入する/i.test(text);
  const hasSoldEvidence = /販売終了|売約済み?|売り切れ|売切|在庫なし|完売|品切れ|ご成約|sold\s*out/i.test(text);
  const hasActiveEvidence = hasPricedOffer || hasPurchaseEvidence;

  // Conflicting page-wide signals can come from recommendations or retained historical markup.
  // Never deactivate when the page is internally contradictory.
  if (hasActiveEvidence && hasSoldEvidence) return 'ambiguous';
  if (hasActiveEvidence) return 'in_stock';
  if (hasSoldEvidence) return 'sold_out';
  return 'ambiguous';
}

function isoBefore(now, hours) {
  return new Date(now.getTime() - hours * 60 * 60 * 1000).toISOString();
}

function priorMissingFailures(candidate) {
  const checkedAt = Date.parse(candidate?.last_inventory_checked_at || '');
  const lastSeenAt = Date.parse(candidate?.last_seen_at || '');
  if (!Number.isFinite(checkedAt)) return 0;
  if (Number.isFinite(lastSeenAt) && lastSeenAt > checkedAt) return 0;
  const stored = Number.parseInt(String(candidate?.inventory_check_failures ?? '0'), 10);
  return Number.isFinite(stored) && stored > 0 ? stored : 0;
}

function relayFailureReason(error) {
  if (error?.code === 'robots_disallowed') return 'robots_disallowed';
  if (Number.isFinite(error?.relayStatus)) return `relay_http_${error.relayStatus}`;
  return 'relay_error';
}

export async function recheckAudioUnionInventory(
  env,
  { now = new Date(), fetchFn = fetch, repository = defaultRepository } = {}
) {
  const settings = getAudioUnionInventoryRecheckSettings(env);
  if (!settings.enabled) return { status: 'skipped', reason: 'disabled' };

  const attemptedAt = now.toISOString();

  try {
    const candidate = await repository.selectInventoryRecheckCandidate(env.DB, 'audiounion', {
      staleBefore: isoBefore(now, settings.minListingAgeHours),
      retryBefore: isoBefore(now, settings.intervalHours)
    });
    if (!candidate) return { status: 'skipped', reason: 'no_candidate' };

    await repository.markInventoryCheckAttempt(env.DB, candidate.id, attemptedAt);

    if (!isAudioUnionUsedDetailUrl(candidate.source_url)) {
      return { status: 'deferred', reason: 'invalid_detail_url', productId: candidate.id, sourceId: candidate.source_id };
    }

    const { relayUrl, relayToken } = relayConfiguration(env);
    const relay = createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn });
    const crawlerSettings = getCrawlerSettings(env);
    const requestDelayMs = getShopRequestDelayMs(
      env,
      SHOP_DEFINITIONS.audiounion,
      crawlerSettings.requestDelayMs
    );

    let page;
    try {
      page = await relay.fetchPage(candidate.source_url, {
        userAgent: crawlerSettings.userAgent,
        requestDelayMs
      });
    } catch (error) {
      return {
        status: 'deferred',
        reason: relayFailureReason(error),
        productId: candidate.id,
        sourceId: candidate.source_id
      };
    }

    const status = Number(page.status);
    if (status === 404 || status === 410) {
      const failureCount = priorMissingFailures(candidate) + 1;
      const deactivate = failureCount >= settings.failureThreshold;
      await repository.recordInventoryMissing(env.DB, candidate.id, attemptedAt, failureCount, deactivate);
      return {
        status: 'checked',
        outcome: deactivate ? 'missing_deactivated' : 'missing_retry',
        httpStatus: status,
        failureCount,
        productId: candidate.id,
        sourceId: candidate.source_id
      };
    }

    if (status === 403 || status === 429 || status >= 500) {
      return {
        status: 'deferred',
        reason: `upstream_http_${status}`,
        productId: candidate.id,
        sourceId: candidate.source_id
      };
    }

    if (status !== 200) {
      return {
        status: 'deferred',
        reason: `unexpected_http_${status}`,
        productId: candidate.id,
        sourceId: candidate.source_id
      };
    }

    if (!String(page.contentType || '').toLowerCase().includes('text/html')) {
      return {
        status: 'deferred',
        reason: 'unexpected_content_type',
        productId: candidate.id,
        sourceId: candidate.source_id
      };
    }

    const classification = classifyAudioUnionInventoryPage(page.body);
    if (classification === 'in_stock') {
      await repository.markInventoryAvailable(env.DB, candidate.id, attemptedAt);
    } else if (classification === 'sold_out') {
      await repository.markInventorySoldOut(env.DB, candidate.id, attemptedAt);
    } else {
      await repository.markInventoryAmbiguous(env.DB, candidate.id, attemptedAt);
    }

    return {
      status: 'checked',
      outcome: classification,
      productId: candidate.id,
      sourceId: candidate.source_id
    };
  } catch (error) {
    return {
      status: 'failed',
      reason: 'inventory_recheck_error',
      error: String(error instanceof Error ? error.message : error).slice(0, 200)
    };
  }
}
