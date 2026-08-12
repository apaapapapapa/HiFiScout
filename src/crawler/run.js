import {
  SHOP_DEFINITIONS,
  getCrawlerSettings,
  getShopEnabled,
  getShopIntervalMinutes,
  getShopMaxPages,
  getShopRequestDelayMs
} from '../config.js';
import { syncProductIdentityResolutions } from '../db/product-identity-repository.js';
import { syncObservedProductFeatureFacts } from '../db/product-feature-repository.js';
import { syncProductMetadata } from '../db/product-metadata-repository.js';
import { syncProductSearchProjections } from '../db/product-search-projection-repository.js';
import { upsertProducts } from '../db/products.js';
import {
  getShopState,
  listShopStates,
  markShopAttempt,
  markShopFailure,
  markShopSuccess
} from '../db/shop-state-repository.js';
import {
  finishCrawlRunFailure,
  finishCrawlRunSuccess,
  startCrawlRun
} from '../db/crawl-run-repository.js';
import { archiveEvidence } from '../evidence/evidence-archive.js';
import { enrichProductCategories } from './category-enricher.js';
import { SHOP_ADAPTERS } from './shops/index.js';
import { createTransport, isTransportConfigured } from './transport.js';
import {
  coverageDecision,
  discoverPages,
  initialPageQueue,
  pageUrl,
  shouldContinueAfterEmpty
} from './strategies.js';

function nowIso(now = new Date()) { return now.toISOString(); }

function definitionFor(adapter) {
  return adapter.definition || Object.values(SHOP_DEFINITIONS).find(value => value.key === adapter.key);
}

function isConfigured(env, adapter) {
  if (!isTransportConfigured(env, adapter)) return false;
  if (adapter.transport === 'relay') return true;
  return !adapter.isConfigured || adapter.isConfigured(env);
}

function countMatches(value, pattern) {
  return [...String(value || '').matchAll(pattern)].length;
}

function diagnoseAudioUnionHtml(html) {
  const text = String(html || '');
  const productPattern = /(?:https?:\/\/www\.audiounion\.jp)?\/ct\/detail\/used\/(\d+)\/?/gi;
  const matches = [...text.matchAll(productPattern)];
  const seen = new Set();
  let positiveContexts = 0;
  let soldContexts = 0;
  let neutralContexts = 0;
  const positivePattern = /在庫あり|カートに入れる|購入する/i;
  const soldPattern = /売約済み?|売り切れ|売切|sold\s*out|在庫なし|完売|品切れ|販売終了|ご成約/i;

  for (const match of matches) {
    const id = match[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const start = Math.max(0, (match.index || 0) - 700);
    const end = Math.min(text.length, (match.index || 0) + match[0].length + 900);
    const context = text.slice(start, end);
    const positive = positivePattern.test(context);
    const sold = soldPattern.test(context);
    if (sold) soldContexts += 1;
    else if (positive) positiveContexts += 1;
    else neutralContexts += 1;
  }

  return {
    links: matches.length,
    uniqueProducts: seen.size,
    positiveContexts,
    soldContexts,
    neutralContexts,
    markers: {
      inStock: countMatches(text, /在庫あり/g),
      cart: countMatches(text, /カートに入れる/g),
      purchase: countMatches(text, /購入する/g),
      reserved: countMatches(text, /売約済み?/g),
      soldOutJa: countMatches(text, /売り切れ|売切/g),
      soldOutEn: countMatches(text, /sold\s*out/gi),
      noStock: countMatches(text, /在庫なし/g),
      completed: countMatches(text, /完売|品切れ|販売終了|ご成約/g)
    }
  };
}

function logUnclassifiedProducts(adapter, products) {
  const unresolved = products.filter(product => product.classificationStatus !== 'classified');
  if (!unresolved.length) return;
  console.warn(JSON.stringify({
    event: 'catalog_unclassified',
    shopKey: adapter.key,
    count: unresolved.length,
    samples: unresolved.slice(0, 5).map(product => ({
      sourceId: product.sourceId,
      rawCategory: product.rawCategory,
      title: product.title,
      state: product.classificationState || 'unclassified',
      candidates: product.candidateCategoryIds || []
    }))
  }));
}

function crawlEvidenceError(message, reason) {
  const error = new Error(message);
  error.evidenceReason = reason;
  return error;
}

async function syncDerivedProductState(env, adapter, products, observedAt) {
  let searchProjection = { changedCount: 0 };
  let identity = {
    identity_exact_match_count: 0,
    identity_alias_match_count: 0,
    identity_fuzzy_match_count: 0,
    identity_unresolved_count: 0,
    identity_veto_count: 0,
    identity_resolution_write_count: 0
  };

  try {
    searchProjection = await syncProductSearchProjections(
      env.DB,
      adapter.key,
      products.map(product => product.sourceId),
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'product_search_projection_sync_failure',
      shopKey: adapter.key,
      message: error?.message || String(error)
    }));
  }

  try {
    identity = await syncProductIdentityResolutions(
      env.DB,
      adapter.key,
      products.map(product => product.sourceId),
      observedAt,
    );
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'product_identity_sync_failure',
      shopKey: adapter.key,
      message: error?.message || String(error)
    }));
  }

  return { searchProjection, identity };
}

export function isShopDue(state, intervalMinutes, now = new Date()) {
  if (state?.backoff_until && new Date(state.backoff_until) > now) return false;
  if (!state?.last_attempt_at) return true;
  return now.getTime() - new Date(state.last_attempt_at).getTime() >= intervalMinutes * 60_000;
}

export function isSuspiciousItemDrop(itemCount, previousItemCount, { minRatio = 0.5, minBaseline = 20 } = {}) {
  if (!Number.isFinite(previousItemCount) || previousItemCount < minBaseline) return false;
  if (!Number.isFinite(itemCount) || itemCount < 0) return true;
  return itemCount / previousItemCount < minRatio;
}

export async function crawlShop(env, adapter, { force = false, now = new Date(), fetchFn = fetch } = {}) {
  const definition = definitionFor(adapter);
  if (!definition) return { shopKey: adapter.key, status: 'skipped', reason: 'shop_definition_missing' };
  if (!getShopEnabled(env, definition)) return { shopKey: adapter.key, status: 'skipped', reason: 'disabled' };
  if (!isConfigured(env, adapter)) return { shopKey: adapter.key, status: 'skipped', reason: 'configuration_missing' };

  const intervalMinutes = getShopIntervalMinutes(env, definition);
  const state = await getShopState(env.DB, adapter.key);
  if (!force && !isShopDue(state, intervalMinutes, now)) return { shopKey: adapter.key, status: 'skipped', reason: 'not_due' };

  const startedAt = nowIso(now);
  await markShopAttempt(env.DB, adapter.key, startedAt);
  const runId = await startCrawlRun(env.DB, adapter.key, startedAt);
  const settings = getCrawlerSettings(env);
  const maxPages = getShopMaxPages(env, definition, settings.maxPagesPerShop);
  const pageLimit = maxPages + Math.max(0, adapter.extraPageAllowance || 0);
  const requestDelayMs = getShopRequestDelayMs(env, definition, settings.requestDelayMs);
  const robotsCache = new Map();
  const items = new Map();
  let pageCount = 0;
  let reachedEnd = false;
  let coverageIncomplete = false;
  let audioUnionDiagnostic = null;
  let lastEvidenceHtml = '';
  let classificationEvidenceHtml = '';
  const transport = createTransport(env, adapter, fetchFn);

  try {
    const pageQueue = initialPageQueue(adapter, maxPages, env, { now, intervalMinutes, state });
    const queuedUrls = new Set(pageQueue.map(pageUrl));

    while (pageQueue.length && pageCount < pageLimit) {
      const page = pageQueue.shift();
      const url = pageUrl(page);
      let html;
      try {
        html = await transport.fetchHtmlPage(url, {
          baseUrl: adapter.baseUrl,
          userAgent: settings.userAgent,
          requestDelayMs,
          fetchFn,
          robotsCache
        });
      } catch (error) {
        if (/HTTP 404/.test(error.message) && (shouldContinueAfterEmpty(adapter) || items.size === 0)) {
          coverageIncomplete = true;
          continue;
        }
        throw error;
      }

      lastEvidenceHtml = html;
      pageCount += 1;
      if (adapter.key === 'audiounion') audioUnionDiagnostic = diagnoseAudioUnionHtml(html);
      let parsed;
      try {
        parsed = adapter.parse(html, page);
      } catch (error) {
        error.evidenceReason = 'parser_failure';
        throw error;
      }
      if (!classificationEvidenceHtml && parsed.some(item => item.classificationStatus !== 'classified')) {
        classificationEvidenceHtml = html;
      }
      const discovered = discoverPages(adapter, html, page);
      if (discovered == null) {
        coverageIncomplete = true;
      } else {
        for (const nextPage of discovered) {
          const nextUrl = pageUrl(nextPage);
          if (!nextUrl || queuedUrls.has(nextUrl)) continue;
          queuedUrls.add(nextUrl);
          pageQueue.push(nextPage);
        }
      }

      if (!parsed.length) {
        if (adapter.dynamicPagination) coverageIncomplete = true;
        if (items.size > 0) {
          if (shouldContinueAfterEmpty(adapter)) continue;
          reachedEnd = true;
          break;
        }
      }

      for (const item of parsed) items.set(item.sourceId, item);
    }

    if (pageQueue.length) coverageIncomplete = true;
    if (!items.size) {
      throw crawlEvidenceError('no products parsed; refusing to mark existing products inactive', 'parser_failure');
    }

    const { deactivateMissing, guardItemCount } = coverageDecision(adapter, {
      reachedEnd,
      coverageIncomplete,
      queueEmpty: pageQueue.length === 0
    });
    if (guardItemCount && isSuspiciousItemDrop(items.size, Number(state?.last_item_count), {
      minRatio: settings.minItemRatio,
      minBaseline: settings.minItemBaseline
    })) {
      throw crawlEvidenceError(
        `item count dropped suspiciously from ${state.last_item_count} to ${items.size}; refusing crawl update`,
        'unexpected_item_count'
      );
    }

    const observedAt = nowIso(new Date());
    const enrichment = await enrichProductCategories({
      db: env.DB,
      adapter,
      products: [...items.values()],
      transport,
      fetchOptions: {
        baseUrl: adapter.baseUrl,
        userAgent: settings.userAgent,
        requestDelayMs,
        fetchFn,
        robotsCache
      },
      now: new Date(observedAt)
    });
    const products = enrichment.products;
    logUnclassifiedProducts(adapter, products);

    let evidence = { archived: false, failed: false };
    if (enrichment.unresolvedCount > 0 && classificationEvidenceHtml) {
      evidence = await archiveEvidence({
        env,
        shopKey: adapter.key,
        crawlRunId: runId,
        reason: 'classification_unresolved',
        html: classificationEvidenceHtml,
        capturedAt: observedAt
      });
    }

    const { changedCount, activityCount, touchedCount, deactivatedCount } = await upsertProducts(
      env.DB,
      adapter.key,
      products,
      observedAt,
      { deactivateMissing, touchIntervalMinutes: settings.productTouchIntervalMinutes }
    );
    const derived = await syncDerivedProductState(env, adapter, products, observedAt);
    const featureFactCount = await syncObservedProductFeatureFacts(env.DB, adapter.key, products, observedAt);
    const metadataChangedCount = await syncProductMetadata(env.DB, adapter.key, products, observedAt);
    await markShopSuccess(env.DB, adapter.key, observedAt, items.size);
    const diagnosticParts = [];
    if (adapter.key === 'audiounion' && audioUnionDiagnostic) {
      diagnosticParts.push(`diag=${JSON.stringify(audioUnionDiagnostic)}`);
    }
    if (enrichment.detailRequests || enrichment.cacheHits || enrichment.unresolvedCount) {
      diagnosticParts.push(`category_enrichment=${JSON.stringify({
        detailRequests: enrichment.detailRequests,
        cacheHits: enrichment.cacheHits,
        enrichedCount: enrichment.enrichedCount,
        unresolvedCount: enrichment.unresolvedCount
      })}`);
    }
    if (derived.searchProjection.changedCount) {
      diagnosticParts.push(`search_projection=${JSON.stringify(derived.searchProjection)}`);
    }
    if (
      derived.identity.identity_resolution_write_count ||
      derived.identity.identity_unresolved_count ||
      derived.identity.identity_veto_count
    ) {
      diagnosticParts.push(`identity=${JSON.stringify(derived.identity)}`);
    }
    if (evidence.status && evidence.status !== 'skipped') {
      diagnosticParts.push(`evidence=${JSON.stringify({ status: evidence.status })}`);
    }
    const diagnosticSuffix = diagnosticParts.length ? ` | ${diagnosticParts.join(' | ')}` : '';
    await finishCrawlRunSuccess(env.DB, runId, {
      finishedAt: observedAt,
      itemCount: items.size,
      pageCount,
      message: `${changedCount} changed, ${activityCount} activity, ${featureFactCount} feature facts, ${metadataChangedCount} metadata changed, ${touchedCount} touched, ${deactivatedCount} deactivated${diagnosticSuffix}`
    });
    return {
      shopKey: adapter.key,
      status: 'success',
      itemCount: items.size,
      pageCount,
      changedCount,
      activityCount,
      featureFactCount,
      metadataChangedCount,
      touchedCount,
      deactivatedCount,
      deactivateMissing,
      searchProjection: derived.searchProjection,
      productIdentity: derived.identity,
      categoryEnrichment: {
        detailRequests: enrichment.detailRequests,
        cacheHits: enrichment.cacheHits,
        enrichedCount: enrichment.enrichedCount,
        unresolvedCount: enrichment.unresolvedCount
      }
    };
  } catch (error) {
    const failedAt = nowIso(new Date());
    if (lastEvidenceHtml) {
      await archiveEvidence({
        env,
        shopKey: adapter.key,
        crawlRunId: runId,
        reason: error.evidenceReason || 'crawl_validation_failure',
        html: lastEvidenceHtml,
        capturedAt: failedAt
      });
    }
    await markShopFailure(env.DB, adapter.key, failedAt, error.message, state?.consecutive_failures || 0);
    await finishCrawlRunFailure(env.DB, runId, { finishedAt: failedAt, pageCount, message: error.message });
    return { shopKey: adapter.key, status: 'failed', error: error.message };
  } finally {
    await transport.close?.();
  }
}

export async function crawlDueShops(env, options = {}) {
  const results = [];
  for (const adapter of SHOP_ADAPTERS) results.push(await crawlShop(env, adapter, options));
  return results;
}

export async function crawlNextDueShop(env, { now = new Date(), fetchFn = fetch } = {}) {
  const states = new Map((await listShopStates(env.DB)).map(row => [row.shop_key, row]));
  const candidates = SHOP_ADAPTERS
    .filter(adapter => {
      const definition = definitionFor(adapter);
      return definition && getShopEnabled(env, definition) && isConfigured(env, adapter);
    })
    .map(adapter => {
      const definition = definitionFor(adapter);
      const interval = getShopIntervalMinutes(env, definition);
      const state = states.get(adapter.key);
      return { adapter, state, interval, due: isShopDue(state, interval, now), lastAttempt: state?.last_attempt_at || '' };
    })
    .filter(candidate => candidate.due)
    .sort((a, b) => a.lastAttempt.localeCompare(b.lastAttempt));
  if (!candidates.length) return { status: 'skipped', reason: 'no_shop_due' };
  return crawlShop(env, candidates[0].adapter, { now, fetchFn });
}
