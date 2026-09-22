import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AuctionOffer, AuctionSearchResult } from "../src/api/auction-contracts.js";
import { productPermalinkPath } from "./product-permalink.js";

type Features = { search: boolean; display: boolean };
let featuresPromise: Promise<Features> | null = null;
export function useAuctionFeatures() {
  const [features, setFeatures] = useState<Features | null>(null);
  useEffect(() => {
    let active = true;
    featuresPromise ??= fetch("/api/auction-features", { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error("features_unavailable");
        const data = (await response.json()) as Partial<Features>;
        return { search: data.search === true, display: data.display === true };
      })
      .catch(() => ({ search: false, display: false }));
    void featuresPromise.then((data) => {
      if (active) setFeatures(data);
    });
    return () => {
      active = false;
    };
  }, []);
  return features;
}
const time = (value: string | null | undefined) =>
  value && Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }) + " JST"
    : "未確認";
const tax = {
  inclusive: "税込",
  exclusive: "税別・税込額未確認",
  exempt: "非課税",
  unknown: "税区分未確認",
};
const units = { single: "単品", pair: "ペア", set: "セット", unknown: "販売単位未確認" };
const subjects = {
  main_unit: "本体",
  accessory: "アクセサリー",
  parts: "部品",
  empty_box: "空箱",
  bundle: "複数製品",
  unknown: "販売対象未確認",
};
const shipping = {
  free: "送料無料（取得元表示）",
  separate: "送料別",
  collect: "送料着払い",
  unknown: "送料未確認",
};
const states = {
  open: "開催中の観測あり",
  ended: "終了確認済み",
  unavailable: "取得元で利用不可",
  unknown: "開催状態未確認",
  end_check_pending: "終了確認待ち",
};
function safeOffer(value: unknown): value is AuctionOffer {
  if (!value || typeof value !== "object") return false;
  const v = value as AuctionOffer;
  return (
    v.source === "yahoo-auctions" &&
    typeof v.auctionId === "string" &&
    /^[a-z][a-z0-9]{5,31}$/u.test(v.auctionId) &&
    v.sourceUrl === `https://auctions.yahoo.co.jp/jp/auction/${v.auctionId}` &&
    typeof v.manufacturer === "string" &&
    typeof v.model === "string" &&
    instant(v.observedAt) &&
    (v.freshUntil === null || instant(v.freshUntil)) &&
    Object.hasOwn(units, v.saleUnit) &&
    Object.hasOwn(subjects, v.saleSubject) &&
    Object.hasOwn(states, v.displayState) &&
    ["fresh", "stale", "unknown"].includes(v.freshness) &&
    typeof v.buyNowPrice === "object" &&
    v.buyNowPrice !== null &&
    ["set", "none", "unknown"].includes(v.buyNowPrice.status) &&
    (v.currentPrice === null || safePrice(v.currentPrice)) &&
    (v.buyNowPrice.status !== "set" || safePrice(v.buyNowPrice.price)) &&
    (v.buyNowPrice.status !== "none" || instant(v.buyNowPrice.observedAt)) &&
    (v.bidCount === null ||
      (Number.isSafeInteger(v.bidCount?.value) &&
        v.bidCount.value >= 0 &&
        instant(v.bidCount.observedAt))) &&
    (v.shipping === null ||
      (Object.hasOwn(shipping, v.shipping?.value ?? "") && instant(v.shipping.observedAt))) &&
    (v.scheduledEndAt === null ||
      (instant(v.scheduledEndAt?.value) && instant(v.scheduledEndAt.observedAt))) &&
    (v.catalogProductId === null ||
      (Number.isSafeInteger(v.catalogProductId) && v.catalogProductId > 0))
  );
}
function instant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/u.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}
function safePrice(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const p = value as NonNullable<AuctionOffer["currentPrice"]>;
  return (
    Number.isSafeInteger(p.amountYen) &&
    p.amountYen >= 0 &&
    p.amountYen <= 1_000_000_000 &&
    Object.hasOwn(tax, p.tax) &&
    instant(p.observedAt)
  );
}
async function readAuctions(
  query: URLSearchParams,
  signal: AbortSignal,
): Promise<AuctionSearchResult> {
  const response = await fetch(`/api/auctions?${query}`, { signal, cache: "no-store" });
  const data: unknown = await response.json();
  if (!response.ok) {
    const reason =
      typeof data === "object" && data !== null
        ? String((data as { error?: unknown }).error ?? "")
        : "";
    throw new Error(
      response.status === 400
        ? reason.includes("minimum_3")
          ? "キーワードは3文字以上です。短い型番は型番欄へ入力してください。"
          : reason.includes("cursor")
            ? "一覧の期限が切れました。再検索してください。"
            : "検索条件を確認してください。"
        : "オークション情報を取得できません。時間をおいて再検索してください。",
    );
  }
  const r = data as Partial<AuctionSearchResult>;
  if (
    !r ||
    !Array.isArray(r.items) ||
    r.items.length > 25 ||
    !r.items.every(safeOffer) ||
    typeof r.hasMore !== "boolean" ||
    !(r.nextCursor === null || typeof r.nextCursor === "string") ||
    typeof r.observedAt !== "string" ||
    !Number.isFinite(Date.parse(r.observedAt)) ||
    typeof r.validUntil !== "string" ||
    !Number.isFinite(Date.parse(r.validUntil)) ||
    !["partial", "unknown"].includes(String(r.coverage)) ||
    (r.hasMore
      ? typeof r.nextCursor !== "string" || !r.nextCursor || r.nextCursor.length > 4096
      : r.nextCursor !== null)
  )
    throw new Error("オークション情報を確認できません。");
  return r as AuctionSearchResult;
}
function useAuctionClock(result: AuctionSearchResult | null) {
  const base = useRef({ server: Date.now(), local: performance.now() });
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (result)
      base.current = {
        server: Math.max(Date.now(), Date.parse(result.observedAt)),
        local: performance.now(),
      };
    const update = () => setNow(base.current.server + performance.now() - base.current.local);
    update();
    const timer = setInterval(update, 1000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, [result]);
  return now;
}
export function AuctionOfferRows({ items, now }: { items: AuctionOffer[]; now: number }) {
  return (
    <ul className="auction-results">
      {items.map((item) => {
        const phase =
          item.displayState === "open" &&
          item.scheduledEndAt &&
          Date.parse(item.scheduledEndAt.value) <= now
            ? "end_check_pending"
            : item.displayState;
        const stale =
          item.freshness === "stale" ||
          (item.freshUntil !== null && Date.parse(item.freshUntil) < now);
        const price = (p: AuctionOffer["currentPrice"]) =>
          p ? (
            <>
              <strong>¥{p.amountYen.toLocaleString("ja-JP")}</strong>
              <small>
                {tax[p.tax]} · {time(p.observedAt)}の観測
              </small>
            </>
          ) : (
            <>未確認</>
          );
        return (
          <li key={item.auctionId} className="auction-row">
            <div className="auction-identity">
              <p className="maker">{item.manufacturer || "メーカー未確定"}</p>
              <h3>{item.model || "型番未確定"}</h3>
              <p>
                {units[item.saleUnit]} · {subjects[item.saleSubject]}
              </p>
              <small>出品ID: {item.auctionId}</small>
              {item.catalogProductId ? (
                <a href={productPermalinkPath(`c-${item.catalogProductId}`)!}>
                  ショップ情報・製品詳細
                </a>
              ) : (
                <span className="auction-note">カタログ対応は未確定</span>
              )}
            </div>
            <dl className="auction-facts">
              <div>
                <dt>現在価格</dt>
                <dd>{price(item.currentPrice)}</dd>
              </div>
              <div>
                <dt>即決価格</dt>
                <dd>
                  {item.buyNowPrice.status === "set"
                    ? price(item.buyNowPrice.price)
                    : item.buyNowPrice.status === "none"
                      ? "設定なし（確認済み）"
                      : "設定の有無を未確認"}
                </dd>
              </div>
              <div>
                <dt>終了予定</dt>
                <dd>
                  {time(item.scheduledEndAt?.value)}
                  <small>
                    {states[phase]}
                    {stale ? " · 古い観測" : ""}
                  </small>
                </dd>
              </div>
              <div>
                <dt>入札・送料</dt>
                <dd>
                  {item.bidCount ? `${item.bidCount.value}件の観測` : "入札数未確認"}
                  <small>{shipping[item.shipping?.value ?? "unknown"]}</small>
                </dd>
              </div>
            </dl>
            <div className="auction-source">
              <a href={item.sourceUrl} target="_blank" rel="noopener noreferrer">
                Yahoo!オークションで確認 ↗
              </a>
              <small>最終確認 {time(item.observedAt)}</small>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
export function AuctionProductSection({ catalogId }: { catalogId: number }) {
  const [result, setResult] = useState<AuctionSearchResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const now = useAuctionClock(result);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setResult(null);
    setError("");
    void readAuctions(
      new URLSearchParams({ catalog: String(catalogId), limit: "8" }),
      controller.signal,
    )
      .then((next) => {
        if (!controller.signal.aborted) setResult(next);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(String(reason.message));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [catalogId, revision]);
  const expired = result !== null && now >= Date.parse(result.validUntil);
  return (
    <section className="auction-product" aria-label="Yahoo!オークションの出品">
      <link rel="stylesheet" href="/auctions.css" />
      <h3>Yahoo!オークション</h3>
      <p className="auction-note">
        入札価格の観測です。ショップの販売価格・相場指標とは別に表示しています。
      </p>
      {loading ? <p role="status">オークション出品を確認中…</p> : null}
      {error ? <p role="status">{error} ショップ情報は引き続きご覧いただけます。</p> : null}
      {expired ? (
        <p role="status">表示の有効期限が切れました。最新の状態を確認してください。</p>
      ) : result ? (
        <>
          {result.items.length ? (
            <AuctionOfferRows items={result.items} now={now} />
          ) : (
            <p>
              確認できる開催中の出品はありません。取得範囲は限定されており、出品の不存在は保証しません。
            </p>
          )}
          {result.hasMore ? (
            <a href={`/auctions?catalog=${catalogId}`}>この製品の出品をすべて検索</a>
          ) : null}
        </>
      ) : null}
      <button type="button" disabled={loading} onClick={() => setRevision((value) => value + 1)}>
        オークション情報を再確認
      </button>
    </section>
  );
}
export function AuctionPermalinkOffers({ enabled }: { enabled: boolean }) {
  const [mount, setMount] = useState<{ node: HTMLElement; id: number } | null>(null);
  useEffect(() => {
    if (!enabled) {
      setMount(null);
      return;
    }
    const page = document.getElementById("product-permalink-page");
    const key = page?.dataset.productKey?.match(/^c-(\d{1,15})$/u);
    if (!page || !key) return;
    const node = document.createElement("div");
    node.className = "auction-permalink-slot";
    page.appendChild(node);
    const update = () => setMount(page.hidden ? null : { node, id: Number(key[1]) });
    update();
    const observer = new MutationObserver(update);
    observer.observe(page, { attributes: true, attributeFilter: ["hidden"] });
    return () => {
      observer.disconnect();
      node.remove();
    };
  }, [enabled]);
  return mount ? createPortal(<AuctionProductSection catalogId={mount.id} />, mount.node) : null;
}
const INITIAL_FIELDS = {
  q: "",
  manufacturer: "",
  model: "",
  category: "",
  min: "",
  max: "",
  buyMin: "",
  buyMax: "",
  buy: "any",
  state: "open",
  unit: "any",
  subject: "any",
  sort: "ending",
  endBefore: "",
  catalog: "",
};
type Fields = typeof INITIAL_FIELDS;
function locationFields(): Fields {
  const p = new URLSearchParams(location.search);
  return Object.fromEntries(
    Object.entries(INITIAL_FIELDS).map(([key, value]) => [key, p.get(key) ?? value]),
  ) as Fields;
}
function fieldParams(fields: Fields) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(fields))
    if (value && value !== "any") p.set(key, value);
  return p;
}
export function AuctionSearchApp() {
  const features = useAuctionFeatures();
  const enabled = features?.search && features.display;
  const [fields, setFields] = useState(locationFields);
  const [applied, setApplied] = useState(() => fieldParams(locationFields()));
  const [result, setResult] = useState<AuctionSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const [revision, setRevision] = useState(0);
  const now = useAuctionClock(result);
  async function search(params: URLSearchParams, more = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError("");
    if (!more) setResult(null);
    try {
      const next = await readAuctions(params, controller.signal);
      if (controller.signal.aborted) return;
      setResult((previous) =>
        more && previous
          ? {
              ...next,
              validUntil: new Date(
                Math.min(Date.parse(previous.validUntil), Date.parse(next.validUntil)),
              ).toISOString(),
              items: [
                ...new Map(
                  [...previous.items, ...next.items].map((item) => [item.auctionId, item]),
                ).values(),
              ],
            }
          : next,
      );
    } catch (reason) {
      if (!controller.signal.aborted) {
        setResult(null);
        setError(reason instanceof Error ? reason.message : "検索できませんでした。");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }
  useEffect(() => {
    if (enabled) void search(new URLSearchParams(applied));
    return () => request.current?.abort();
  }, [enabled, applied, revision]);
  useEffect(() => {
    const pop = () => {
      const next = locationFields();
      setFields(next);
      setApplied(fieldParams(next));
    };
    window.addEventListener("popstate", pop);
    return () => window.removeEventListener("popstate", pop);
  }, []);
  const update = (name: keyof Fields, value: string) =>
    setFields((current) => ({ ...current, [name]: value }));
  const input = (name: keyof Fields, label: string, type = "text") => (
    <label>
      {label}
      <input
        name={name}
        type={type}
        value={fields[name]}
        maxLength={120}
        onChange={(event) => update(name, event.target.value)}
      />
    </label>
  );
  const select = (name: keyof Fields, label: string, options: Record<string, string>) => (
    <label>
      {label}
      <select
        name={name}
        value={fields[name]}
        onChange={(event) => update(name, event.target.value)}
      >
        {Object.entries(options).map(([value, text]) => (
          <option value={value} key={value}>
            {text}
          </option>
        ))}
      </select>
    </label>
  );
  const expired = result !== null && now >= Date.parse(result.validUntil);
  return (
    <>
      <link rel="stylesheet" href="/auctions.css" />
      <header className="hero">
        <div>
          <p className="eyebrow">AUCTION SEARCH</p>
          <a className="brand-home" href="/">
            <h1>HiFiScout</h1>
          </a>
          <p className="lead">オーディオのオークション出品を探す。</p>
        </div>
        <a href="/">ショップの在庫検索へ</a>
      </header>
      <main className="auction-page">
        <h2>Yahoo!オークション検索</h2>
        <p>保存済みの観測情報です。価格・入札・終了予定は元ページで確認してください。</p>
        {!features ? (
          <p role="status">公開状況を確認しています…</p>
        ) : !enabled ? (
          <p role="status">オークション検索は現在公開していません。</p>
        ) : (
          <>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                const p = fieldParams(fields);
                history.pushState(null, "", `${location.pathname}${p.size ? "?" + p : ""}`);
                setApplied(p);
              }}
            >
              <div className="auction-main-search">
                {input("q", "キーワード（3文字以上）")}
                <button type="submit" disabled={loading}>
                  検索する
                </button>
              </div>
              <details className="auction-filters">
                <summary>条件を絞り込む</summary>
                <div className="auction-filter-grid">
                  {input("manufacturer", "メーカー")}
                  {input("model", "型番（短い型番も入力可）")}
                  {select("category", "カテゴリ", {
                    "": "すべて",
                    AMP: "アンプ",
                    "SRC.DISC": "CDプレーヤー等",
                  })}
                  {input("min", "現在価格の下限（円）", "number")}
                  {input("max", "現在価格の上限（円）", "number")}
                  {input("buyMin", "即決価格の下限（円）", "number")}
                  {input("buyMax", "即決価格の上限（円）", "number")}
                  {select("buy", "即決価格", {
                    any: "すべて",
                    set: "設定あり",
                    none: "設定なしを確認",
                    unknown: "未確認",
                  })}
                  {select("state", "開催状態", {
                    open: "開催中・鮮度範囲内",
                    pending: "終了確認待ち",
                    ended: "終了確認済み",
                    stale: "古い観測",
                    unknown: "開催状態未確認",
                    unavailable: "取得元で利用不可",
                    all: "すべて",
                  })}
                  {select("unit", "販売単位", { any: "すべて", ...units })}
                  {select("subject", "販売対象", { any: "すべて", ...subjects })}
                  <label>
                    終了予定の上限（日本時間）
                    <input
                      type="datetime-local"
                      value={
                        fields.endBefore && Number.isFinite(Date.parse(fields.endBefore))
                          ? new Date(Date.parse(fields.endBefore) + 9 * 60 * 60_000)
                              .toISOString()
                              .slice(0, 16)
                          : ""
                      }
                      onChange={(event) =>
                        update(
                          "endBefore",
                          event.target.value
                            ? new Date(`${event.target.value}:00+09:00`).toISOString()
                            : "",
                        )
                      }
                    />
                  </label>
                </div>
                <p className="auction-note">
                  価格条件・価格順は税込または非課税と確認できる金額が対象です。税別・税区分不明は価格順の末尾となり、価格範囲には含めません。送料込み総額・単価ではありません。
                </p>
              </details>
              <div className="auction-toolbar">
                {select("sort", "並び順", {
                  ending: "終了予定が近い順",
                  current_asc: "現在価格が安い順",
                  current_desc: "現在価格が高い順",
                  buy_asc: "即決価格が安い順",
                  buy_desc: "即決価格が高い順",
                  newest: "最終確認が新しい順",
                })}
                <button type="submit" disabled={loading}>
                  条件を適用
                </button>
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    setFields(INITIAL_FIELDS);
                    history.pushState(null, "", location.pathname);
                    setApplied(fieldParams(INITIAL_FIELDS));
                  }}
                >
                  条件をクリア
                </button>
              </div>
            </form>
            {fieldParams(fields).toString() !== applied.toString() ? (
              <p role="status" className="auction-note">
                条件が変更されています。「条件を適用」で検索結果を更新してください。
              </p>
            ) : null}
            <p className="auction-note">
              取得範囲は限定的です。総件数は未集計です。更新でページ間の移動・取りこぼしが起こる場合があります。最新の状態は再検索で確認できます。
            </p>
            {loading ? <p role="status">出品を検索しています…</p> : null}
            {error ? <p role="alert">{error}</p> : null}
            {expired ? (
              <p role="status">表示の有効期限が切れました。再検索してください。</p>
            ) : result ? (
              <>
                <p className="auction-note">
                  検索時刻 {time(result.observedAt)} · 取得範囲{" "}
                  {result.coverage === "partial" ? "一部" : "未確認"}
                </p>
                {result.items.length ? (
                  <AuctionOfferRows items={result.items} now={now} />
                ) : (
                  <p role="status">条件に一致する保存済みの出品はありません。</p>
                )}
              </>
            ) : null}
            <div className="auction-toolbar">
              <button
                type="button"
                disabled={loading}
                onClick={() => setRevision((value) => value + 1)}
              >
                最新の状態で再検索
              </button>
              {result?.hasMore && !expired ? (
                <button
                  type="button"
                  disabled={loading}
                  onClick={() => {
                    const p = new URLSearchParams(applied);
                    p.set("cursor", result.nextCursor!);
                    void search(p, true);
                  }}
                >
                  次の出品を読み込む
                </button>
              ) : null}
            </div>
          </>
        )}
      </main>
      <footer>
        <p>
          HiFiScoutは取得元とは関係のない非公式ツールです。最終観測価格は落札価格・成約価格ではありません。
        </p>
      </footer>
    </>
  );
}
