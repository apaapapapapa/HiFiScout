import { parseProductPage } from '../parser.js';

const DEFAULT_ENTRY_URL = 'https://www.audiounion.jp/st/new_arrival_used.html';

export const audioUnionAdapter = {
  key: 'audiounion',
  name: 'Audio Union',
  baseUrl: 'https://www.audiounion.jp',
  requestDelayMs: 10_000,
  isConfigured() {
    return true;
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
