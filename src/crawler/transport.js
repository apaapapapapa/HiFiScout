import { createBrowserHtmlFetcher } from './browser.js';
import { fetchHtmlPage } from './fetch.js';
import { createRelayHtmlFetcher } from './relay.js';

function legacyRelayConfiguration(env, adapter) {
  if (adapter?.key === 'audiounion') {
    return {
      relayUrl: env?.AUDIOUNION_RELAY_URL?.trim() || '',
      relayToken: env?.AUDIOUNION_RELAY_TOKEN?.trim() || ''
    };
  }
  if (adapter?.key === 'hifido') {
    return {
      relayUrl: env?.HIFIDO_RELAY_URL?.trim() || '',
      relayToken: env?.HIFIDO_RELAY_TOKEN?.trim() || ''
    };
  }
  return { relayUrl: '', relayToken: '' };
}

export function relayConfiguration(env, adapter) {
  const shared = {
    relayUrl: env?.CRAWL_RELAY_URL?.trim() || '',
    relayToken: env?.CRAWL_RELAY_TOKEN?.trim() || ''
  };
  if (shared.relayUrl && shared.relayToken) return shared;
  return legacyRelayConfiguration(env, adapter);
}

export function isTransportConfigured(env, adapter) {
  if (adapter?.transport !== 'relay') return true;
  const { relayUrl, relayToken } = relayConfiguration(env, adapter);
  return Boolean(relayUrl && relayToken);
}

export function createTransport(env, adapter, fetchFn = fetch) {
  if (adapter?.transport === 'browser') return createBrowserHtmlFetcher(env.BROWSER);
  if (adapter?.transport === 'relay') {
    const { relayUrl, relayToken } = relayConfiguration(env, adapter);
    return createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn });
  }
  return {
    fetchHtmlPage(url, options) {
      return fetchHtmlPage(url, options);
    },
    async close() {}
  };
}
