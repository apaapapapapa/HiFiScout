import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

import { CatalogAdmin } from "./admin-catalog.js";
import { CorrectionReportsAdmin } from "./admin-correction-reports.js";
import { ListingAdmin } from "./admin-listings.js";

type AdminTab = "catalog" | "listings" | "reports";

interface AdminSectionLink {
  label: string;
  selector: string;
}

const ADMIN_TABS: readonly AdminTab[] = ["catalog", "listings", "reports"];
const ADMIN_SECTION_LINKS: Record<AdminTab, readonly AdminSectionLink[]> = {
  catalog: [
    { label: "Catalog検索・編集", selector: "#catalog-search-heading" },
    { label: "重複Catalog統合", selector: "#duplicate-heading" },
    { label: "未検証候補", selector: "#candidate-search-heading" },
    { label: "CSV診断", selector: ".export-panel" },
  ],
  listings: [
    { label: "登録商品を検索", selector: "#listing-search-heading" },
    { label: "登録商品一覧", selector: ".listing-table" },
  ],
  reports: [{ label: "誤り報告キュー", selector: "#correction-reports-heading" }],
};

function requestedTab(): AdminTab {
  if (window.location.hash === "#listings") return "listings";
  if (window.location.hash === "#reports") return "reports";
  return "catalog";
}

function tabUrl(tab: AdminTab): string {
  const url = new URL(window.location.href);
  url.searchParams.delete("q");
  url.searchParams.delete("shopKey");
  url.searchParams.delete("scope");
  url.hash = tab === "catalog" ? "" : tab;
  return url.toString();
}

function scrollToAdminTarget(selector: string): void {
  const target = document.querySelector<HTMLElement>(selector);
  if (!target) return;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  target.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}

function setControlledFieldValue(
  element: HTMLInputElement | HTMLSelectElement,
  value: string,
): void {
  const prototype =
    element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (setter) setter.call(element, value);
  else element.value = value;
  element.dispatchEvent(
    new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }),
  );
}

function applyDeepLinkFilters(tab: AdminTab): boolean {
  const params = new URLSearchParams(window.location.search);
  const query = params.get("q")?.trim() || "";
  if (tab === "catalog") {
    if (!query) return true;
    const input = document.querySelector<HTMLInputElement>("#catalog-catalog-query");
    if (!input || input.disabled) return false;
    const form = input.closest("form");
    if (!form) return false;
    setControlledFieldValue(input, query);
    window.requestAnimationFrame(() => form.requestSubmit());
    return true;
  }
  if (tab === "listings") {
    if (!query) return true;
    const queryInput = document.querySelector<HTMLInputElement>("#listings-listing-query");
    const shopInput = document.querySelector<HTMLInputElement>("#listings-shop-key");
    const scopeSelect = document.querySelector<HTMLSelectElement>("#listings-listing-scope");
    if (!queryInput || queryInput.disabled || !shopInput || !scopeSelect) return false;
    const form = queryInput.closest("form");
    if (!form) return false;
    setControlledFieldValue(queryInput, query);
    const shopKey = params.get("shopKey")?.trim() || "";
    if (shopKey) setControlledFieldValue(shopInput, shopKey);
    if (params.get("scope") === "all") setControlledFieldValue(scopeSelect, "all");
    window.requestAnimationFrame(() => form.requestSubmit());
    return true;
  }
  return true;
}

export function AdminConsole() {
  const [activeTab, setActiveTab] = useState<AdminTab>(requestedTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminTab>>(() => new Set([requestedTab()]));
  const appliedDeepLink = useRef<string | null>(null);
  const activeSectionLabel =
    activeTab === "catalog"
      ? "Knowledge Catalog 内の機能"
      : activeTab === "listings"
        ? "登録商品 内の機能"
        : "情報の誤り報告 内の機能";

  useEffect(() => {
    const onPopState = () => {
      const tab = requestedTab();
      setActiveTab(tab);
      setMountedTabs((current) => new Set(current).add(tab));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (activeTab === "reports") return;
    const params = new URLSearchParams(window.location.search);
    if (!params.get("q")?.trim()) return;
    const deepLinkKey = `${activeTab}:${window.location.search}`;
    if (appliedDeepLink.current === deepLinkKey) return;
    let cancelled = false;
    let retryTimer = 0;
    const tryApply = () => {
      if (cancelled) return;
      if (applyDeepLinkFilters(activeTab)) {
        appliedDeepLink.current = deepLinkKey;
        return;
      }
      retryTimer = window.setTimeout(tryApply, 50);
    };
    tryApply();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
    };
  }, [activeTab]);

  const selectTab = (tab: AdminTab, updateHistory = true) => {
    setActiveTab(tab);
    setMountedTabs((current) => new Set(current).add(tab));
    if (updateHistory) window.history.pushState(null, "", tabUrl(tab));
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollToAdminTarget(`#${tab}-pane`));
    });
  };

  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: AdminTab) => {
    let target: AdminTab | null = null;
    const index = ADMIN_TABS.indexOf(tab);
    if (event.key === "ArrowLeft")
      target = ADMIN_TABS[(index + ADMIN_TABS.length - 1) % ADMIN_TABS.length];
    else if (event.key === "ArrowRight") target = ADMIN_TABS[(index + 1) % ADMIN_TABS.length];
    else if (event.key === "Home") target = ADMIN_TABS[0];
    else if (event.key === "End") target = ADMIN_TABS[ADMIN_TABS.length - 1];
    if (!target) return;
    event.preventDefault();
    selectTab(target);
    window.requestAnimationFrame(() => document.getElementById(`admin-tab-${target}`)?.focus());
  };

  return (
    <main className="admin-shell">
      <header className="admin-header">
        <a
          className="brand-link"
          href="https://hifiscout.tokyojp.workers.dev/"
          rel="noreferrer"
          aria-label="HiFiScout を開く"
        >
          <span className="brand-mark" aria-hidden="true">
            <img src="/hifiscout-mark.jpg" alt="" />
          </span>
          <span className="brand-copy">
            <strong>HiFiScout</strong>
            <span>Admin Console</span>
          </span>
        </a>
        <div className="header-copy">
          <p className="eyebrow eyebrow-inverse">ADMIN OPERATIONS</p>
          <h1>
            HiFiScout <span>管理コンソール</span>
          </h1>
          <p className="lede">
            Catalogと販売店から取得した登録商品、利用者からの事実誤り報告を、ひとつの画面から検索・監査・修正できます。
          </p>
        </div>
        <div className="header-actions">
          <span className="access-badge">
            <span aria-hidden="true" />
            Cloudflare Access 保護中
          </span>
          <a
            className="header-link"
            href="https://hifiscout.tokyojp.workers.dev/"
            rel="noreferrer"
            target="_blank"
          >
            検索サイトを開く <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      <nav className="admin-tabs-shell" aria-label="管理メニュー">
        <div className="admin-menu-group admin-menu-primary">
          <span className="admin-menu-label">管理対象</span>
          <div className="admin-tabs" role="tablist" aria-label="管理コンソール">
            <button
              id="admin-tab-catalog"
              className="admin-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "catalog"}
              aria-controls="catalog-pane"
              tabIndex={activeTab === "catalog" ? 0 : -1}
              onClick={() => selectTab("catalog")}
              onKeyDown={(event) => handleTabKey(event, "catalog")}
            >
              <span className="admin-tab-title">Knowledge Catalog</span>
              <span className="admin-tab-description">製品マスター・カテゴリ・CSV監査</span>
            </button>
            <button
              id="admin-tab-listings"
              className="admin-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "listings"}
              aria-controls="listings-pane"
              tabIndex={activeTab === "listings" ? 0 : -1}
              onClick={() => selectTab("listings")}
              onKeyDown={(event) => handleTabKey(event, "listings")}
            >
              <span className="admin-tab-title">登録商品</span>
              <span className="admin-tab-description">
                店舗listing・メーカー・型番・カテゴリ補正
              </span>
            </button>
            <button
              id="admin-tab-reports"
              className="admin-tab"
              type="button"
              role="tab"
              aria-selected={activeTab === "reports"}
              aria-controls="reports-pane"
              tabIndex={activeTab === "reports" ? 0 : -1}
              onClick={() => selectTab("reports")}
              onKeyDown={(event) => handleTabKey(event, "reports")}
            >
              <span className="admin-tab-title">誤り報告</span>
              <span className="admin-tab-description">匿名報告の確認・監査・解決</span>
            </button>
          </div>
        </div>
        <div className="admin-menu-group admin-menu-secondary">
          <span className="admin-menu-label">機能へ移動</span>
          <div className="admin-section-links" role="group" aria-label={activeSectionLabel}>
            {ADMIN_SECTION_LINKS[activeTab].map((item) => (
              <button
                key={item.selector}
                className="admin-section-link"
                type="button"
                onClick={() => scrollToAdminTarget(item.selector)}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </nav>

      <div hidden={activeTab !== "catalog"}>
        {mountedTabs.has("catalog") ? <CatalogAdmin /> : null}
      </div>
      <div hidden={activeTab !== "listings"}>
        {mountedTabs.has("listings") ? <ListingAdmin /> : null}
      </div>
      <div
        id="reports-pane"
        role="tabpanel"
        aria-labelledby="admin-tab-reports"
        hidden={activeTab !== "reports"}
      >
        {mountedTabs.has("reports") ? <CorrectionReportsAdmin /> : null}
      </div>
    </main>
  );
}

const root = document.getElementById("admin-root");
if (root) createRoot(root).render(<AdminConsole />);
