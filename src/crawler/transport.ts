import type {
  CrawlerEnv,
  HtmlTransport,
  RelayConfiguration,
  RelayFetcherConfig,
  ShopAdapter,
} from "./types.js";
import { createBrowserHtmlFetcher } from "./browser.js";
import { fetchHtmlPage } from "./fetch.js";
import { createRelayHtmlFetcher } from "./relay.js";

/** Only the transport selector is read, so callers may pass any adapter-shaped object. */
type TransportSelector = Pick<ShopAdapter, "transport">;

export function relayConfiguration(env: CrawlerEnv | undefined): RelayConfiguration {
  return {
    relayUrl: env?.CRAWL_RELAY_URL?.trim() || "",
    relayToken: env?.CRAWL_RELAY_TOKEN?.trim() || "",
  };
}

export function isTransportConfigured(
  env: CrawlerEnv | undefined,
  adapter: TransportSelector | undefined,
): boolean {
  if (adapter?.transport !== "relay") return true;
  const { relayUrl, relayToken } = relayConfiguration(env);
  return Boolean(relayUrl && relayToken);
}

export function createTransport(
  env: CrawlerEnv,
  adapter: TransportSelector | undefined,
  fetchFn: typeof fetch = fetch,
): HtmlTransport {
  if (adapter?.transport === "browser") return createBrowserHtmlFetcher(env.BROWSER);
  if (adapter?.transport === "relay") {
    const { relayUrl, relayToken } = relayConfiguration(env);
    const config: RelayFetcherConfig = { relayUrl, relayToken, fetchFn };
    return createRelayHtmlFetcher(config);
  }
  return {
    fetchHtmlPage(url, options) {
      return fetchHtmlPage(url, options);
    },
    async close() {},
  };
}
