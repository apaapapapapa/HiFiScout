import { parseProductPage } from '../parser.js';

const ROOTS = [
  { path: 'rA-HMLU', category: '' },
  { path: 'rA-HDPU', category: 'ヘッドホン' }
];

export const fujiyaAvicAdapter = {
  key: 'fujiya-avic',
  name: 'フジヤエービック',
  baseUrl: 'https://www.fujiya-avic.co.jp',
  *pageUrls(maxPages) {
    const pagesPerRoot = Math.max(1, Math.floor(maxPages / ROOTS.length));
    for (const root of ROOTS) {
      yield { url: `https://www.fujiya-avic.co.jp/shop/r/${root.path}/?ps=50`, category: root.category };
      for (let page = 2; page <= pagesPerRoot; page += 1) {
        yield { url: `https://www.fujiya-avic.co.jp/shop/r/${root.path}_p${page}/?ps=50`, category: root.category };
      }
    }
  },
  parse(html, page) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      hintedCategory: page.category,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/g\/g|fujiya-avic\.co\.jp\/shop\/goods\//i
    });
  }
};
