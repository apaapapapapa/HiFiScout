import { PRODUCT_CORRECTION_REPORT_REASONS } from "../src/api/product-correction-report-contract.js";
import type { ProductCorrectionReportReason } from "../src/api/product-correction-report-contract.js";

const REASON_LABELS: Record<ProductCorrectionReportReason, string> = {
  wrong_manufacturer: "メーカーが違う",
  wrong_model: "型番が違う",
  wrong_category: "カテゴリが違う",
  incorrect_grouping: "同一商品のまとめ方が違う",
  stale_or_missing_offer: "在庫が古い・不足している",
  other_factual_error: "その他の事実誤り",
};

interface ReportTarget {
  listingProductId?: number;
  label: string;
}

export function correctionReportTargets(dialog: ParentNode): ReportTarget[] {
  const heading = dialog.querySelector<HTMLElement>("#offers-title")?.textContent?.trim() || "この商品";
  const targets: ReportTarget[] = [{ label: `${heading}（商品全体）` }];
  for (const offer of dialog.querySelectorAll<HTMLElement>(".offer")) {
    const history = offer.querySelector<HTMLElement>("[data-history]");
    const listingProductId = Number(history?.dataset.history || 0);
    if (!Number.isSafeInteger(listingProductId) || listingProductId <= 0) continue;
    const shop = offer.querySelector<HTMLElement>(".offer-shop")?.textContent?.trim() || "ショップ不明";
    const title = offer.querySelector<HTMLElement>(".offer-title")?.textContent?.trim() || `listing #${listingProductId}`;
    targets.push({ listingProductId, label: `${shop}: ${title}` });
  }
  return targets;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

function reportPanel(productKey: string, dialog: HTMLElement): HTMLElement {
  const details = element("details", { class: "offers-note correction-report-panel" });
  details.dataset.correctionReport = productKey;
  const summary = element("summary");
  summary.textContent = "情報の誤りを報告";
  details.append(summary);

  const note = element("p");
  note.textContent =
    "報告は匿名の確認候補として保存され、内容を確認してから補正します。連絡先や個人情報は入力しないでください。";
  details.append(note);

  const form = element("form");
  const targetLabel = element("label");
  targetLabel.append("報告する対象 ");
  const targetSelect = element("select", { name: "target" });
  for (const target of correctionReportTargets(dialog)) {
    const option = element("option");
    option.value = target.listingProductId == null ? "" : String(target.listingProductId);
    option.textContent = target.label;
    targetSelect.append(option);
  }
  targetLabel.append(targetSelect);
  form.append(targetLabel);

  const reasonLabel = element("label");
  reasonLabel.append("誤りの種類 ");
  const reasonSelect = element("select", { name: "reason", required: "" });
  for (const reason of PRODUCT_CORRECTION_REPORT_REASONS) {
    const option = element("option");
    option.value = reason;
    option.textContent = REASON_LABELS[reason];
    reasonSelect.append(option);
  }
  reasonLabel.append(reasonSelect);
  form.append(reasonLabel);

  const explanationLabel = element("label");
  explanationLabel.append("補足（任意） ");
  const explanation = element("textarea", {
    name: "explanation",
    maxlength: "500",
    rows: "3",
    placeholder: "事実確認に必要な範囲で入力してください",
  });
  explanationLabel.append(explanation);
  form.append(explanationLabel);

  const actions = element("div", { class: "offer-actions" });
  const submit = element("button", { type: "submit" });
  submit.textContent = "報告を送信";
  actions.append(submit);
  form.append(actions);

  const status = element("p", { role: "status", "aria-live": "polite" });
  form.append(status);

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const listingProductId = Number(targetSelect.value || 0);
    const body = {
      productKey,
      ...(listingProductId > 0 ? { listingProductId } : {}),
      reason: reasonSelect.value,
      explanation: explanation.value,
    };
    const controls = [...form.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>("input, select, textarea, button")];
    controls.forEach((control) => {
      control.disabled = true;
    });
    status.textContent = "送信しています…";
    void fetch("/api/product-correction-reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      cache: "no-store",
      body: JSON.stringify(body),
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        status.textContent = "報告を受け付けました。確認後、必要な場合のみデータを補正します。";
        explanation.value = "";
      })
      .catch(() => {
        status.textContent = "報告を送信できませんでした。時間をおいて再度お試しください。";
      })
      .finally(() => {
        controls.forEach((control) => {
          control.disabled = false;
        });
      });
  });

  details.append(form);
  return details;
}

let activeProductKey = "";

function ensureReportPanel(): void {
  if (!activeProductKey) return;
  const dialog = document.getElementById("offers-dialog");
  const content = document.getElementById("offers-content");
  if (!dialog || !content || !content.querySelector("#offers-title")) return;
  const existing = dialog.querySelector<HTMLElement>("[data-correction-report]");
  if (existing?.dataset.correctionReport === activeProductKey) return;
  existing?.remove();
  dialog.append(reportPanel(activeProductKey, dialog));
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-offers]") : null;
      const key = target?.dataset.offers?.trim() || "";
      if (!key) return;
      activeProductKey = key;
      queueMicrotask(ensureReportPanel);
    },
    true,
  );

  new MutationObserver(ensureReportPanel).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
}
