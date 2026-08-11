import { parseProductPage } from '../parser.js';

const DEFAULT_ENTRY_URL = 'https://www.audiounion.jp/st/new_arrival_used.html';

export const audioUnionAdapter = {
  key: 'audiounion',
  name: 'Audio Union',
  baseUrl: 'https://www.audiounion.jp',
  transport: 'relay',
  relayUrlEnv: 'AUDIOUNION_RELAY_URL',
  relayTokenEnv: 'AUDIOUNION_RELAY_TOKEN',
  requestDelayMs: 10_000,
  isConfigured(env) {
    return Boolean(env?.AUDIOUNION_RELAY_URL?.trim() && env?.AUDIOUNION_RELAY_TOKEN?.trim());
  },
  *pageUrls(_maxPages, env) {
    yield env?.AUDIOUNION_ENTRY_URL?.trim() || DEFAULT_ENTRY_URL;
  },
  parse(html, pageUrl) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /audiounion\.jp\/ct\/detail\/used\/\d+\/?/i
    });
  }
};
