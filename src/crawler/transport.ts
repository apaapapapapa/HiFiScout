import type {
  CrawlerEnv,
  HtmlTransport,
  RelayConfiguration,
  RelayFetcherConfig,
  TransportKind,
} from "./types.js";
import { createBrowserHtmlFetcher } from "./browser.js";
import { fetchHtmlPage } from "./fetch.js";
import { createRelayHtmlFetcher } from "./relay.js";

export function relayConfiguration(env: CrawlerEnv | undefined): RelayConfiguration {
  return {
    relayUrl: env?.CRAWL_RELAY_URL?.trim() || "",
    relayToken: env?.CRAWL_RELAY_TOKEN?.trim() || "",
  };
}

export function isTransportConfigured(
  env: CrawlerEnv | undefined,
  transport: TransportKind | undefined,
): boolean {
  if (transport !== "relay") return true;
  const { relayUrl, relayToken } = relayConfiguration(env);
  return Boolean(relayUrl && relayToken);
}

export function createTransport(
  env: CrawlerEnv,
  transport: TransportKind | undefined,
  fetchFn: typeof fetch = fetch,
): HtmlTransport {
  if (transport === "browser") return createBrowserHtmlFetcher(env.BROWSER);
  if (transport === "relay") {
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
