import { createBrowserHtmlFetcher } from "./browser.js";
import { fetchHtmlPage } from "./fetch.js";
import { createRelayHtmlFetcher } from "./relay.js";

export function relayConfiguration(env) {
  return {
    relayUrl: env?.CRAWL_RELAY_URL?.trim() || "",
    relayToken: env?.CRAWL_RELAY_TOKEN?.trim() || "",
  };
}

export function isTransportConfigured(env, adapter) {
  if (adapter?.transport !== "relay") return true;
  const { relayUrl, relayToken } = relayConfiguration(env);
  return Boolean(relayUrl && relayToken);
}

export function createTransport(env, adapter, fetchFn = fetch) {
  if (adapter?.transport === "browser") return createBrowserHtmlFetcher(env.BROWSER);
  if (adapter?.transport === "relay") {
    const { relayUrl, relayToken } = relayConfiguration(env);
    return createRelayHtmlFetcher({ relayUrl, relayToken, fetchFn });
  }
  return {
    fetchHtmlPage(url, options) {
      return fetchHtmlPage(url, options);
    },
    async close() {},
  };
}
