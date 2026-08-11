export function pageUrl(page) {
  return typeof page === 'string' ? page : page.url;
}

export function initialPageQueue(adapter, maxPages, env, context) {
  return [...adapter.pageUrls(maxPages, env, context)];
}

export function discoverPages(adapter, html, page) {
  if (!adapter.dynamicPagination || !adapter.discoverPageUrls) return [];
  return adapter.discoverPageUrls(html, page);
}

export function shouldContinueAfterEmpty(adapter) {
  return adapter.continueOnEmpty === true;
}

export function coverageDecision(adapter, { reachedEnd, coverageIncomplete, queueEmpty }) {
  const deactivateMissing = !adapter.partialCoverage && (
    reachedEnd || (adapter.dynamicPagination && !coverageIncomplete && queueEmpty)
  );
  return {
    deactivateMissing,
    guardItemCount: deactivateMissing || adapter.guardItemCount === true
  };
}
