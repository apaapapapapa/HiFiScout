import { useEffect, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createRoot } from "react-dom/client";

import { CatalogAdmin } from "./admin-catalog.js";
import { ListingAdmin } from "./admin-listings.js";

type AdminTab = "catalog" | "listings";

function requestedTab(): AdminTab {
  return window.location.hash === "#listings" ? "listings" : "catalog";
}

function tabUrl(tab: AdminTab): string {
  const url = new URL(window.location.href);
  url.hash = tab === "listings" ? "listings" : "";
  return url.toString();
}

function AdminConsole() {
  const [activeTab, setActiveTab] = useState<AdminTab>(requestedTab);
  const [mountedTabs, setMountedTabs] = useState<Set<AdminTab>>(() => new Set([requestedTab()]));

  useEffect(() => {
    const onPopState = () => {
      const tab = requestedTab();
      setActiveTab(tab);
      setMountedTabs((current) => new Set(current).add(tab));
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const selectTab = (tab: AdminTab, updateHistory = true) => {
    setActiveTab(tab);
    setMountedTabs((current) => new Set(current).add(tab));
    if (updateHistory) window.history.pushState(null, "", tabUrl(tab));
  };

  const handleTabKey = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: AdminTab) => {
    let target: AdminTab | null = null;
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      target = tab === "catalog" ? "listings" : "catalog";
    } else if (event.key === "Home") {
      target = "catalog";
    } else if (event.key === "End") {
      target = "listings";
    }
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
          <h1>HiFiScout <span>管理コンソール</span></h1>
          <p className="lede">
            Catalogと販売店から取得した登録商品を、ひとつの画面から検索・監査・修正できます。
          </p>
        </div>
        <div className="header-actions">
          <span className="access-badge"><span aria-hidden="true" />Cloudflare Access 保護中</span>
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

      <nav className="admin-tabs-shell" aria-label="管理対象の切り替え">
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
            <span className="admin-tab-description">店舗listing・メーカー・型番・カテゴリ補正</span>
          </button>
        </div>
      </nav>

      <div hidden={activeTab !== "catalog"}>{mountedTabs.has("catalog") ? <CatalogAdmin /> : null}</div>
      <div hidden={activeTab !== "listings"}>{mountedTabs.has("listings") ? <ListingAdmin /> : null}</div>
    </main>
  );
}

const root = document.getElementById("admin-root");
if (!root) throw new Error("Missing #admin-root");
createRoot(root).render(<AdminConsole />);
