import { useEffect, useState } from "react";
import type { FormEvent } from "react";

import {
  PRODUCT_CORRECTION_REPORT_REASONS,
  type ProductCorrectionReportReason,
} from "../src/api/product-correction-report-contract.js";

export interface ProductCorrectionReportTarget {
  listingProductId?: number;
  label: string;
}

export interface ProductCorrectionReportFormProps {
  productKey: string;
  productLabel: string;
  targets: readonly ProductCorrectionReportTarget[];
}

const REASON_LABELS: Record<ProductCorrectionReportReason, string> = {
  wrong_manufacturer: "メーカーが違う",
  wrong_model: "型番が違う",
  wrong_category: "カテゴリが違う",
  incorrect_grouping: "同一商品のまとめ方が違う",
  stale_or_missing_offer: "在庫が古い・不足している",
  other_factual_error: "その他の事実誤り",
};

type SubmissionState = "idle" | "submitting" | "success" | "error";

export function ProductCorrectionReportForm({
  productKey,
  productLabel,
  targets,
}: ProductCorrectionReportFormProps) {
  const [listingProductId, setListingProductId] = useState("");
  const [reason, setReason] = useState<ProductCorrectionReportReason>("wrong_manufacturer");
  const [explanation, setExplanation] = useState("");
  const [submissionState, setSubmissionState] = useState<SubmissionState>("idle");

  useEffect(() => {
    setListingProductId("");
    setReason("wrong_manufacturer");
    setExplanation("");
    setSubmissionState("idle");
  }, [productKey]);

  const disabled = submissionState === "submitting";
  const statusText =
    submissionState === "submitting"
      ? "送信しています…"
      : submissionState === "success"
        ? "報告を受け付けました。確認後、必要な場合のみデータを補正します。"
        : submissionState === "error"
          ? "報告を送信できませんでした。時間をおいて再度お試しください。"
          : "";

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled) return;
    setSubmissionState("submitting");
    const parsedListingProductId = Number(listingProductId || 0);
    try {
      const response = await fetch("/api/product-correction-reports", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({
          productKey,
          ...(parsedListingProductId > 0 ? { listingProductId: parsedListingProductId } : {}),
          reason,
          explanation,
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setExplanation("");
      setSubmissionState("success");
    } catch {
      setSubmissionState("error");
    }
  };

  return (
    <details className="offers-note correction-report-panel" data-correction-report={productKey}>
      <summary>情報の誤りを報告</summary>
      <p>
        報告は匿名の確認候補として保存され、内容を確認してから補正します。連絡先や個人情報は入力しないでください。
      </p>
      <form onSubmit={(event) => void submit(event)}>
        <label>
          報告する対象
          <select
            name="target"
            value={listingProductId}
            disabled={disabled}
            onChange={(event) => setListingProductId(event.currentTarget.value)}
          >
            <option value="">{productLabel}（商品全体）</option>
            {targets.map((target) => (
              <option
                key={target.listingProductId ?? "product"}
                value={target.listingProductId == null ? "" : String(target.listingProductId)}
              >
                {target.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          誤りの種類
          <select
            name="reason"
            value={reason}
            disabled={disabled}
            onChange={(event) =>
              setReason(event.currentTarget.value as ProductCorrectionReportReason)
            }
          >
            {PRODUCT_CORRECTION_REPORT_REASONS.map((value) => (
              <option key={value} value={value}>
                {REASON_LABELS[value]}
              </option>
            ))}
          </select>
        </label>
        <label>
          補足（任意）
          <textarea
            name="explanation"
            value={explanation}
            disabled={disabled}
            maxLength={500}
            rows={3}
            placeholder="事実確認に必要な範囲で入力してください"
            onChange={(event) => setExplanation(event.currentTarget.value)}
          />
        </label>
        <div className="offer-actions">
          <button type="submit" disabled={disabled}>
            報告を送信
          </button>
        </div>
        <p role="status" aria-live="polite">
          {statusText}
        </p>
      </form>
    </details>
  );
}
