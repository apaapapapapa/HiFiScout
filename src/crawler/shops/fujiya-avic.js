import { cleanText } from '../normalize.js';
import { parseProductPage } from '../parser.js';

const PAGE_SIZE = 50;
const ROOTS = [
  { path: 'rA-EAPU', category: 'イヤホン' },
  { path: 'rA-HPAU', category: 'DAP・ヘッドホンアンプ' },
  { path: 'rA-HDPU', category: 'ヘッドホン' },
  { path: 'rA-HMLU', category: 'アンプ・スピーカー・プレーヤー' },
  { path: 'rA-DTMU', category: 'DJ機器・DTM' }
];

function pageUrl(rootPath, page = 1) {
  const suffix = page === 1 ? rootPath : `${rootPath}_p${page}`;
  return `https://www.fujiya-avic.co.jp/shop/r/${suffix}/?ps=${PAGE_SIZE}`;
}

export function parseFujiyaResultCount(html) {
  const text = cleanText(html);
  const match = text.match(/(?:検索結果|該当件数)\s*([0-9,，]+)\s*件|([0-9,，]+)\s*件あります/);
  const raw = match?.[1] || match?.[2];
  return raw ? Number.parseInt(raw.replace(/[，,]/g, ''), 10) : null;
}

export const fujiyaAvicAdapter = {
  key: 'fujiya-avic',
  name: 'フジヤエービック',
  baseUrl: 'https://www.fujiya-avic.co.jp',
  dynamicPagination: true,
  continueOnEmpty: true,
  *pageUrls() {
    for (const root of ROOTS) {
      yield { url: pageUrl(root.path), category: root.category, rootPath: root.path, page: 1 };
    }
  },
  discoverPageUrls(html, page) {
    if (page.page !== 1) return [];
    const count = parseFujiyaResultCount(html);
    if (count == null) return null;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    return Array.from({ length: totalPages - 1 }, (_, index) => {
      const pageNumber = index + 2;
      return {
        url: pageUrl(page.rootPath, pageNumber),
        category: page.category,
        rootPath: page.rootPath,
        page: pageNumber
      };
    });
  },
  parse(html, page) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      hintedCategory: page.category,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i
    });
  }
};
