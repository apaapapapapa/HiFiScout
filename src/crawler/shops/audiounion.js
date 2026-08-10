import { parseProductPage } from '../parser.js';

export const audioUnionAdapter = {
  key: 'audiounion',
  name: 'Audio Union',
  baseUrl: 'https://www.audiounion.jp',
  isConfigured(env) {
    return Boolean(env?.AUDIOUNION_ENTRY_URL?.trim());
  },
  *pageUrls(maxPages, env) {
    const configured = env?.AUDIOUNION_ENTRY_URL?.trim();
    if (!configured) return;
    yield configured;
    for (let page = 2; page <= maxPages; page += 1) {
      const url = new URL(configured);
      url.searchParams.set('page', String(page));
      yield url.toString();
    }
  },
  parse(html, pageUrl) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: pageUrl,
      productUrlPattern: /audiounion/i
    });
  }
};
