import { useCallback, useEffect, useMemo, useState } from "react";
import type { FormEvent } from "react";

import {
  PRODUCT_CORRECTION_REPORT_REASONS,
  PRODUCT_CORRECTION_REPORT_STATUSES,
  type ProductCorrectionReportReason,
  type ProductCorrectionReportStatus,
} from "../src/api/product-correction-report-contract.js";
import { adminJson, dateText, genericErrorText } from "./admin-shared.js";

interface CorrectionReport {
  id: number;
  productKey: string;
  listingProductId: number | null;
  reason: ProductCorrectionReportReason;
  explanation: string;
  snapshot: { manufacturer: string; model: string; category: string; shopKey: string };
  status: ProductCorrectionReportStatus;
  resolutionNote: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

interface CorrectionReportListResponse {
  items: CorrectionReport[];
  nextBeforeId: number | null;
  hasMore: boolean;
}

const REASON_LABELS: Record<ProductCorrectionReportReason, string> = {
  wrong_manufacturer: "メーカーが違う",
  wrong_model: "型番が違う",
  wrong_category: "カテゴリが違う",
  incorrect_grouping: "商品のまとめ方が違う",
  stale_or_missing_offer: "在庫情報が古い・不足",
  other_factual_error: "その他の事実誤り",
};

const STATUS_LABELS: Record<ProductCorrectionReportStatus, string> = {
  open: "未確認",
  in_review: "確認中",
  accepted: "補正済み",
  rejected: "却下",
  duplicate: "重複",
};

type ResolutionAction = "accepted" | "rejected" | "duplicate";

function targetUrl(report: CorrectionReport): string {
  const url = new URL(window.location.origin);
  if (report.listingProductId !== null) {
    url.searchParams.set("listing", String(report.listingProductId));
    url.hash = "listings";
  } else {
    url.searchParams.set("productKey", report.productKey);
  }
  return url.toString();
}

function targetLabel(report: CorrectionReport): string {
  const product = [report.snapshot.manufacturer, report.snapshot.model].filter(Boolean).join(" ");
  const listing = report.listingProductId === null ? "商品全体" : `listing #${report.listingProductId}`;
  return `${product || report.productKey} / ${listing}`;
}

export function CorrectionReportsAdmin() {
  const [status, setStatus] = useState<ProductCorrectionReportStatus | "">("open");
  const [reason, setReason] = useState<ProductCorrectionReportReason | "">("");
  const [shopKey, setShopKey] = useState("");
  const [maxAgeDays, setMaxAgeDays] = useState("90");
  const [items, setItems] = useState<CorrectionReport[]>([]);
  const [nextBeforeId, setNextBeforeId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [notes, setNotes] = useState<Record<number, string>>({});

  const params = useMemo(() => {
    const value = new URLSearchParams({ limit: "50" });
    if (status) value.set("status", status);
    if (reason) value.set("reason", reason);
    if (shopKey.trim()) value.set("shopKey", shopKey.trim().toLowerCase());
    if (maxAgeDays) value.set("maxAgeDays", maxAgeDays);
    return value;
  }, [maxAgeDays, reason, shopKey, status]);

  const load = useCallback(
    async (beforeId: number | null = null, append = false) => {
      setBusy(true);
      setMessage("報告を読み込んでいます…");
      try {
        const query = new URLSearchParams(params);
        if (beforeId !== null) query.set("beforeId", String(beforeId));
        const result = await adminJson<CorrectionReportListResponse>(
          `/api/admin/correction-reports?${query}`,
        );
        setItems((current) => (append ? [...current, ...result.items] : result.items));
        setNextBeforeId(result.nextBeforeId);
        setMessage(result.items.length ? "報告キューを表示しています。" : "該当する報告はありません。");
      } catch (error) {
        setMessage(`報告の取得に失敗しました: ${genericErrorText(error)}`);
      } finally {
        setBusy(false);
      }
    },
    [params],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const submitFilters = (event: FormEvent) => {
    event.preventDefault();
    void load();
  };

  const act = async (report: CorrectionReport, action: "review_started" | ResolutionAction) => {
    const note = notes[report.id]?.trim() || "";
    if (action !== "review_started" && !note) {
      setMessage("解決操作には監査メモを入力してください。補正済みの場合は実施した補正を記録します。");
      return;
    }
    setBusy(true);
    try {
      await adminJson(`/api/admin/correction-reports/${report.id}`, {
        method: "PATCH",
        body: JSON.stringify({ action, note }),
      });
      setMessage(action === "review_started" ? "確認中にしました。" : "報告を解決しました。");
      await load();
    } catch (error) {
      setMessage(`更新に失敗しました: ${genericErrorText(error)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section id="correction-reports-pane" className="admin-pane" aria-labelledby="correction-reports-heading">
      <div className="section-heading">
        <p className="eyebrow">DATA QUALITY FEEDBACK</p>
        <h2 id="correction-reports-heading">情報の誤り報告</h2>
        <p>匿名報告は候補です。報告から直接データを変更せず、既存のCatalog/登録商品補正を完了してから「補正済み」にします。</p>
      </div>

      <form className="admin-filter-grid" onSubmit={submitFilters}>
        <label>状態<select value={status} onChange={(event) => setStatus(event.currentTarget.value as ProductCorrectionReportStatus | "")}><option value="">すべて</option>{PRODUCT_CORRECTION_REPORT_STATUSES.map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</select></label>
        <label>理由<select value={reason} onChange={(event) => setReason(event.currentTarget.value as ProductCorrectionReportReason | "")}><option value="">すべて</option>{PRODUCT_CORRECTION_REPORT_REASONS.map((value) => <option key={value} value={value}>{REASON_LABELS[value]}</option>)}</select></label>
        <label>ショップ<input value={shopKey} onChange={(event) => setShopKey(event.currentTarget.value)} placeholder="shop key" /></label>
        <label>期間<select value={maxAgeDays} onChange={(event) => setMaxAgeDays(event.currentTarget.value)}><option value="7">7日</option><option value="30">30日</option><option value="90">90日</option><option value="180">180日</option><option value="">全期間</option></select></label>
        <button type="submit" disabled={busy}>絞り込む</button>
      </form>

      <p className="status-line" role="status" aria-live="polite">{message}</p>
      <div className="table-scroll">
        <table className="listing-table">
          <thead><tr><th>報告</th><th>対象</th><th>内容</th><th>状態 / 対応</th></tr></thead>
          <tbody>
            {items.map((report) => (
              <tr key={report.id}>
                <td><strong>#{report.id}</strong><br /><span>{REASON_LABELS[report.reason]}</span><br /><small>{dateText(report.createdAt)}</small></td>
                <td><a href={targetUrl(report)}>{targetLabel(report)}</a><br /><small>{report.snapshot.category || "カテゴリ不明"}</small><br />{report.snapshot.shopKey ? <small>{report.snapshot.shopKey}</small> : null}</td>
                <td>{report.explanation || <span>説明なし</span>}</td>
                <td>
                  <strong>{STATUS_LABELS[report.status]}</strong>
                  {report.status === "open" ? <div><button type="button" disabled={busy} onClick={() => void act(report, "review_started")}>確認を開始</button></div> : null}
                  {report.status === "in_review" || report.status === "open" ? (
                    <>
                      <label><span className="sr-only">監査メモ</span><textarea value={notes[report.id] || ""} maxLength={500} placeholder="補正内容、却下理由、重複先など" onChange={(event) => setNotes((current) => ({ ...current, [report.id]: event.currentTarget.value }))} /></label>
                      <div className="offer-actions">
                        {report.status === "in_review" ? <button type="button" disabled={busy} onClick={() => void act(report, "accepted")}>補正済み</button> : null}
                        <button type="button" disabled={busy} onClick={() => void act(report, "rejected")}>却下</button>
                        <button type="button" disabled={busy} onClick={() => void act(report, "duplicate")}>重複</button>
                      </div>
                    </>
                  ) : report.resolutionNote ? <small>{report.resolutionNote}</small> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {nextBeforeId !== null ? <button type="button" disabled={busy} onClick={() => void load(nextBeforeId, true)}>さらに読み込む</button> : null}
    </section>
  );
}
