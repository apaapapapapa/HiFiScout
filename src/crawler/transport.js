import { createBrowserHtmlFetcher } from './browser.js';
import { fetchHtmlPage } from './fetch.js';
import { createRelayHtmlFetcher } from './relay.js';

function firstConfigured(env, names = []) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

export function relayConfiguration(env, adapter) {
  return {
    relayUrl: firstConfigured(env, ['CRAWL_RELAY_URL', adapter?.relayUrlEnv]),
    relayToken: firstConfigured(env, ['CRAWL_RELAY_TOKEN', adapter?.relayTokenEnv])
  };
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
