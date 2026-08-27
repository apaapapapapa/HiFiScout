import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Root } from "react-dom/client";

import {
  ProductCorrectionReportForm,
  type ProductCorrectionReportTarget,
} from "./product-correction-report-form.js";

function textContent(scope: HTMLElement, selector: string): string {
  const node = scope.querySelector(selector) as HTMLElement | null;
  return node?.textContent?.trim() || "";
}

export function correctionReportTargets(dialog: HTMLElement): ProductCorrectionReportTarget[] {
  const targets: ProductCorrectionReportTarget[] = [];
  const offerNodes = Array.from(dialog.querySelectorAll(".offer")) as HTMLElement[];
  for (const offer of offerNodes) {
    const history = offer.querySelector("[data-history]") as HTMLElement | null;
    const listingProductId = Number(history?.dataset.history || 0);
    if (!Number.isSafeInteger(listingProductId) || listingProductId <= 0) continue;
    const shop = textContent(offer, ".offer-shop") || "ショップ不明";
    const title = textContent(offer, ".offer-title") || `listing #${listingProductId}`;
    targets.push({ listingProductId, label: `${shop}: ${title}` });
  }
  return targets;
}

let activeProductKey = "";
let reportRoot: Root | null = null;
let renderedFingerprint = "";

function ensureReportPanel(): void {
  if (!activeProductKey) return;
  const dialog = document.getElementById("offers-dialog");
  const content = document.getElementById("offers-content");
  if (!dialog || !content || !content.querySelector("#offers-title")) return;

  const targets = correctionReportTargets(dialog);
  const productLabel = textContent(dialog, "#offers-title") || "この商品";
  const fingerprint = JSON.stringify([
    activeProductKey,
    productLabel,
    targets.map((target) => [target.listingProductId, target.label]),
  ]);
  if (fingerprint === renderedFingerprint) return;

  let host = document.getElementById("correction-report-root");
  if (!host) {
    host = document.createElement("div");
    host.id = "correction-report-root";
    dialog.appendChild(host);
  }
  reportRoot ??= createRoot(host);
  reportRoot.render(
    createElement(ProductCorrectionReportForm, {
      productKey: activeProductKey,
      productLabel,
      targets,
    }),
  );
  renderedFingerprint = fingerprint;
}

if (typeof document !== "undefined") {
  document.addEventListener(
    "click",
    (event) => {
      const eventTarget = event.target;
      if (!(eventTarget instanceof HTMLElement)) return;
      const target = eventTarget.closest("[data-offers]") as HTMLElement | null;
      const key = target?.dataset.offers?.trim() || "";
      if (!key) return;
      activeProductKey = key;
      renderedFingerprint = "";
      queueMicrotask(ensureReportPanel);
    },
    true,
  );

  new MutationObserver(ensureReportPanel).observe(document.documentElement, {
    subtree: true,
    childList: true,
  });
}
