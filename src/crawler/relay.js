import { decodeHtmlResponse } from './fetch.js';

function configured(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function upstreamError(status) {
  const error = new Error(
    status === 403 || status === 429
      ? `crawl blocked with HTTP ${status}`
      : `crawl failed with HTTP ${status}`
  );
  error.status = status;
  return error;
}

export function createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn = fetch } = {}) {
  return {
    async fetchHtmlPage(url, { userAgent, requestDelayMs } = {}) {
      if (!configured(relayUrl)) throw new Error('relay URL is not configured');
      if (!configured(relayToken)) throw new Error('relay token is not configured');

      const response = await fetchFn(relayUrl.trim(), {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${relayToken.trim()}`,
          'Accept': 'text/html,application/xhtml+xml',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          url,
          userAgent,
          requestDelayMs: Number(requestDelayMs) || 0
        }),
        redirect: 'follow'
      });

      const upstreamStatus = Number.parseInt(response.headers.get('x-hifiscout-upstream-status') || '', 10);
      if (!response.ok) {
        if (Number.isFinite(upstreamStatus)) throw upstreamError(upstreamStatus);
        if (response.status === 401 || response.status === 403) {
          throw new Error(`relay authentication failed with HTTP ${response.status}`);
        }
        let detail = '';
        try {
          detail = (await response.text()).replace(/\s+/g, ' ').trim().slice(0, 200);
        } catch {
          // Keep the status-only error when the relay body cannot be read.
        }
        throw new Error(`relay failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`);
      }

      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('text/html')) throw new Error(`unexpected relay content type: ${contentType}`);
      return decodeHtmlResponse(response);
    },

    async close() {}
  };
}
