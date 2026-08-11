import { cleanText } from '../normalize.js';
import { parseProductPage } from '../parser.js';

const PAGE_SIZE = 50;
const NEW_ARRIVALS_PATH = 'ea-usednw_s1';

function pageUrl(page = 1) {
  if (page === 1) return 'https://www.fujiya-avic.co.jp/shop/e/ea-usednw_s1/';
  return `https://www.fujiya-avic.co.jp/shop/e/${NEW_ARRIVALS_PATH}_p${page}/?ps=${PAGE_SIZE}`;
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
    yield { url: pageUrl(), page: 1 };
  },
  discoverPageUrls(html, page) {
    if (page.page !== 1) return [];
    const count = parseFujiyaResultCount(html);
    if (count == null) return null;
    const totalPages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    return Array.from({ length: totalPages - 1 }, (_, index) => {
      const pageNumber = index + 2;
      return {
        url: pageUrl(pageNumber),
        page: pageNumber
      };
    });
  },
  parse(html, page) {
    return parseProductPage(html, {
      shopKey: this.key,
      baseUrl: page.url,
      productUrlPattern: /fujiya-avic\.co\.jp\/shop\/(?:g\/g|goods\/)/i
    });
  }
};
