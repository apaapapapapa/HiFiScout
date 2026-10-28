import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { audioUnionAdapter } from "../src/crawler/shops/audiounion.js";
import {
  audioUnionInventoryRecheck,
  classifyAudioUnionInventoryPage,
  extractAudioUnionOfferFacts,
  isAudioUnionUsedDetailUrl,
} from "../src/crawler/shops/audiounion-inventory.js";
import { diagnoseAudioUnionHtml } from "../src/crawler/shops/audiounion-diagnostics.js";
import { createHandler } from "../infra/audiounion-lambda/index.js";
import { initialPageQueue, coverageDecision } from "../src/crawler/strategies.js";
import { selectInventoryRecheckCandidate } from "../src/db/inventory-recheck-repository.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

const CATEGORY = "https://www.audiounion.jp/shop/c/camp-integrated-all_lS/";
const DETAIL = "https://www.audiounion.jp/shop/g/g22U9059782635/";

// Minimal factual structure observed on the public used-category/detail pages on 2026-10-28.
function card({
  code = "22U9059782635",
  kind = "S",
  maker = "SOULNOTE",
  model = "A-0S",
  price = "90,000",
  status = "",
  href = `/shop/g/g${code}/`,
}: Partial<
  Record<"code" | "kind" | "maker" | "model" | "price" | "status" | "href", string>
> = {}) {
  return `<dl class="block-thumbnail-t--goods js-enhanced-ecommerce-item">
    <input name="class1" type="hidden" value="${kind}">
    <dt><a href="${href}"><img alt="中古 ${maker} ${model}"></a></dt>
    <dd><p class="block-thumbnail-t--goods-category">プリメインアンプ</p>
      <p class="block-thumbnail-t--goods-brand">${maker}</p>
      <div class="block-thumbnail-t--goods-name"><a href="${href}"><span>${model}</span></a></div>
      <div class="net-price"><span class="is-price">143,000</span></div>
      <div class="block-thumbnail-t--price price js-enhanced-ecommerce-goods-price">${price}</div>
      ${status}<div class="block-thumbnail-t--shop-name">新宿店</div></dd></dl>`;
}

function detail({
  code = "22U9059782635",
  kind = "S",
  stock = "1",
  cart = true,
  disabled = false,
  related = "",
} = {}) {
  return `<main><div class="pane-goods-right-side js-goods-variation-detaill">
    <input id="hidden_goods" value="${code}" type="hidden"><input id="hidden_class1" value="${kind}" type="hidden">
    <h1 class="block-goods-name--text">プリメインアンプ A-0S</h1>
    <div class="block-goods-price">販売価格 90,000</div>
    <dl class="is-guarantee"><dt>保証：</dt><dd>6か月</dd></dl>
    <div class="goods-detail-status"><dl><dt>状態</dt><dd>動作確認済み</dd></dl><dl><dt>付属品</dt><dd>リモコン、元箱なし</dd></dl></div>
    <dl class="block-goods-code"><dt>商品コード</dt><dd id="spec_goods">${code}</dd></dl>
    <dl class="block-goods-stock"><dt>在庫</dt><dd id="spec_stock_msg">${stock}</dd></dl>
    ${cart ? `<button class="block-add-cart--btn" data-goods="${code}" ${disabled ? "disabled" : ""}>カートに追加する</button>` : ""}
    </div><aside>${related}</aside></main>`;
}

test("renewed AudioUnion cards keep used identity, selling prices and adjacent product boundaries", () => {
  const items = audioUnionAdapter.parse(
    card() +
      card({
        code: "4958136010546-9-909",
        maker: "LUXMAN",
        model: "D-10X",
        price: "お問い合わせください",
      }) +
      card({
        code: "22U0000000001",
        maker: "Unknown Audio Labs",
        model: "Revision II + PSU (1m)",
        price: "44,800",
        status: "<img alt='売約済'>",
      }) +
      card({ kind: "N", code: "NEW" }) +
      card({ kind: "B", code: "BUYBACK" }),
    CATEGORY,
  );
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((item) => [
      item.sourceId,
      item.manufacturer,
      item.model,
      item.priceYen,
      item.stockStatus,
    ]),
    [
      ["goods:22U9059782635", "SOULNOTE", "A-0S", 90000, "in_stock"],
      ["goods:4958136010546-9-909", "LUXMAN", "D-10X", null, "unknown"],
      ["goods:22U0000000001", "Unknown Audio Labs", "Revision II + PSU (1m)", 44800, "sold_out"],
    ],
  );
  assert.equal(items[0].sourceUrl, DETAIL);
  assert.equal(items[0].rawCategory, "プリメインアンプ");
  assert.equal(items[0].rawManufacturer, "SOULNOTE");
  assert.ok(items.every((item) => item.conditionText === "中古"));
});

test("renewed AudioUnion ignores hidden, foreign, ambiguous and duplicate cards", () => {
  const visible = card();
  for (const hidden of [
    `<!--${card({ code: "HIDDEN" })}-->`,
    `<script>${card({ code: "HIDDEN" })}</script>`,
    `<style>${card({ code: "HIDDEN" })}</style>`,
    `<noscript>${card({ code: "HIDDEN" })}</noscript>`,
  ]) {
    assert.deepEqual(
      audioUnionAdapter.parse(hidden + visible + visible, CATEGORY),
      audioUnionAdapter.parse(visible, CATEGORY),
    );
  }
  for (const href of [
    "https://elsewhere.test/shop/g/g22U9059782635/",
    `${DETAIL}?x=1`,
    `${DETAIL}#x`,
    "https://user@www.audiounion.jp/shop/g/g22U9059782635/",
  ])
    assert.deepEqual(audioUnionAdapter.parse(card({ href }), CATEGORY), []);
  assert.deepEqual(audioUnionAdapter.parse(card({ kind: "" }), CATEGORY), []);
  assert.equal(
    audioUnionAdapter.parse(card({ status: "在庫あり 売約済" }), CATEGORY)[0].stockStatus,
    "unknown",
  );
});

test("renewed AudioUnion discovery stays partial, capped, used-only and on the immediate category page", () => {
  assert.equal(initialPageQueue(audioUnionAdapter, 3, {}).length, 3);
  assert.equal(
    initialPageQueue(audioUnionAdapter, 20, {
      AUDIOUNION_ENTRY_URL: "https://www.audiounion.jp/st/new_arrival_used.html",
    }).length,
    11,
  );
  assert.equal(
    coverageDecision(audioUnionAdapter, {
      reachedEnd: true,
      coverageIncomplete: false,
      queueEmpty: true,
    }).deactivateMissing,
    false,
  );
  assert.equal(audioUnionAdapter.discovery.policy.emptyPage, "continue");
  const page = (href: string) =>
    `<div class="block-goods-list--pager"><li class="pager-next"><a rel="next" href="${href}">次</a></li></div>`;
  const next = "https://www.audiounion.jp/shop/c/camp-integrated-all_p2_lS/";
  assert.deepEqual(audioUnionAdapter.discovery.discoverTargets(page(next), CATEGORY), [next]);
  for (const invalid of [
    "/shop/goods/search.aspx?class1=S&p=2",
    "/shop/c/camp-integrated-all_p2_lN/",
    "/shop/c/camp-control-all_p2_lS/",
    "/shop/c/camp-integrated-all_p99_lS/",
    `${next}?ps=1000`,
    "https://elsewhere.test/shop/c/camp-integrated-all_p2_lS/",
  ])
    assert.equal(audioUnionAdapter.discovery.discoverTargets(page(invalid), CATEGORY), null);
  assert.deepEqual(
    audioUnionAdapter.discovery.discoverTargets(
      `<script>${page(next)}</script><div class="block-goods-list--pager"><span>1件</span></div>`,
      CATEGORY,
    ),
    [],
  );
  assert.equal(audioUnionAdapter.discovery.discoverTargets("<html>error</html>", CATEGORY), null);
  const empty =
    '<div class="block-category-list"><p class="alert">ご指定の条件に一致する商品が見つかりませんでした。</p></div>';
  assert.deepEqual(audioUnionAdapter.discovery.discoverTargets(empty, CATEGORY), []);
  assert.equal(
    audioUnionAdapter.discovery.discoverTargets(`<script>${empty}</script>`, CATEGORY),
    null,
  );
});

test("renewed detail availability requires the matching used goods identity and its stock controls", () => {
  const listing = { sourceUrl: DETAIL };
  assert.equal(isAudioUnionUsedDetailUrl(DETAIL), true);
  assert.equal(audioUnionInventoryRecheck.candidateUrlPrefix, "https://www.audiounion.jp/shop/g/g");
  assert.equal(classifyAudioUnionInventoryPage(detail(), listing), "in_stock");
  assert.equal(
    classifyAudioUnionInventoryPage(
      detail({ stock: "0", cart: false, related: "在庫あり カートに追加する" }),
      listing,
    ),
    "sold_out",
  );
  assert.equal(
    classifyAudioUnionInventoryPage(detail({ stock: "在庫がありません", cart: false }), listing),
    "sold_out",
  );
  assert.equal(classifyAudioUnionInventoryPage(detail({ stock: "0" }), listing), "unknown");
  assert.equal(
    classifyAudioUnionInventoryPage(
      detail({ stock: "お問い合わせください", cart: false }),
      listing,
    ),
    "unknown",
  );
  assert.equal(
    classifyAudioUnionInventoryPage(detail({ stock: "", disabled: true }), listing),
    "unknown",
  );
  assert.equal(classifyAudioUnionInventoryPage(detail({ code: "OTHER" }), listing), "unknown");
  assert.equal(classifyAudioUnionInventoryPage(detail({ kind: "N" }), listing), "unknown");
  assert.equal(classifyAudioUnionInventoryPage(detail() + detail(), listing), "unknown");
  assert.equal(classifyAudioUnionInventoryPage(detail()), "unknown");
  assert.equal(
    classifyAudioUnionInventoryPage("<main>カートに追加する</main>", listing),
    "unknown",
  );
});

test("renewed AudioUnion offer facts read explicit used-detail fields", () => {
  const facts = extractAudioUnionOfferFacts(detail(), "2026-10-28T00:00:00Z");
  assert.deepEqual(
    facts?.map((fact) => [fact.factId, fact.state, fact.warrantyMonths]),
    [
      ["remote_control", "present", undefined],
      ["original_box", "absent", undefined],
      ["operation_confirmed", "present", undefined],
      ["shop_warranty", "present", 6],
    ],
  );
  assert.ok(facts?.every((fact) => fact.ruleId.startsWith("audiounion.detail.v2.")));
  assert.equal(extractAudioUnionOfferFacts(`<script>${detail()}</script>`, "2026-10-28"), null);
  assert.equal(extractAudioUnionOfferFacts(detail({ kind: "B" }), "2026-10-28"), null);
  const diagnostic = diagnoseAudioUnionHtml(
    card() + `<script>${card({ code: "hidden" })}</script>`,
  );
  assert.equal(diagnostic.uniqueProducts, 1);
  assert.equal(diagnostic.links, 2);
});

test("legacy URL retirement cannot become a sold observation or starve new detail checks", async () => {
  const { sqlite, db } = migratedSqlite();
  try {
    const insert =
      sqlite.prepare(`INSERT INTO products(shop_key,source_id,title,source_url,first_seen_at,last_seen_at,last_changed_at,stock_status,is_active)
      VALUES ('audiounion',?,'SOULNOTE A-0S',?,'2026-10-01','2026-10-01','2026-10-01','in_stock',1)`);
    insert.run("223257", "https://www.audiounion.jp/ct/detail/used/223257/");
    const window = {
      staleBefore: "2026-10-28",
      retryBefore: "2026-10-28",
      candidateUrlPrefix: audioUnionInventoryRecheck.candidateUrlPrefix,
    };
    assert.equal(await selectInventoryRecheckCandidate(db, "audiounion", window), null);
    insert.run("goods:22U9059782635", DETAIL);
    assert.equal(
      (await selectInventoryRecheckCandidate(db, "audiounion", window))?.source_url,
      DETAIL,
    );
    assert.equal(
      sqlite.prepare("SELECT stock_status FROM products WHERE source_id='223257'").get()
        ?.stock_status,
      "in_stock",
    );
  } finally {
    sqlite.close();
  }
});

const token = "test-token-with-at-least-thirty-two-characters";
const event = (url: string) => ({
  headers: { authorization: `Bearer ${token}` },
  requestContext: { http: { method: "POST" } },
  body: JSON.stringify({ url }),
});

test("relay accepts only renewed category/detail shapes and continues enforcing robots", async () => {
  const calls: string[] = [];
  const handler = createHandler({
    env: {
      RELAY_TOKEN: token,
      MIN_REQUEST_DELAY_MS: "0",
      AUDIOUNION_ENTRY_URL: "https://www.audiounion.jp/st/new_arrival_used.html",
    },
    sleepFn: async () => {},
    fetchFn: async (url) => {
      calls.push(url);
      return new Response(
        url.endsWith("robots.txt") ? "User-agent: *\nDisallow: /shop/goods/search.aspx\n" : card(),
        { status: 200 },
      );
    },
  });
  for (const url of [
    CATEGORY,
    "https://www.audiounion.jp/shop/c/camp-integrated-all_p2_lS/",
    DETAIL,
  ])
    assert.equal((await handler(event(url))).statusCode, 200);
  const count = calls.length;
  for (const url of [
    "https://www.audiounion.jp/shop/goods/search.aspx?class1=S",
    CATEGORY.replace("_lS", "_lB"),
    CATEGORY.replace("amp-integrated-all", "unrecognized"),
    `${CATEGORY}?ps=1000`,
    `${DETAIL}?x=1`,
    `${DETAIL}#x`,
    DETAIL.replace("https:", "http:"),
    DETAIL.replace("www.", "user@www."),
  ])
    assert.equal((await handler(event(url))).statusCode, 400);
  assert.equal(calls.length, count);
  const blocked: string[] = [];
  const denying = createHandler({
    env: { RELAY_TOKEN: token, MIN_REQUEST_DELAY_MS: "0" },
    sleepFn: async () => {},
    fetchFn: async (url) => {
      blocked.push(url);
      return new Response("User-agent: *\nDisallow: /shop/c/\n", { status: 200 });
    },
  });
  assert.equal((await denying(event(CATEGORY))).statusCode, 409);
  assert.deepEqual(blocked, ["https://www.audiounion.jp/robots.txt"]);
});

test("renewed relay detail redirects cannot change the goods identity", async () => {
  const calls: string[] = [];
  const handler = createHandler({
    env: { RELAY_TOKEN: token, MIN_REQUEST_DELAY_MS: "0" },
    sleepFn: async () => {},
    fetchFn: async (url) => {
      calls.push(url);
      return url.endsWith("robots.txt")
        ? new Response("User-agent: *\nAllow: /\n")
        : new Response(null, {
            status: 302,
            headers: { location: "https://www.audiounion.jp/shop/g/gOTHER/" },
          });
    },
  });
  assert.notEqual((await handler(event(DETAIL))).statusCode, 200);
  assert.deepEqual(calls, ["https://www.audiounion.jp/robots.txt", DETAIL]);
});
