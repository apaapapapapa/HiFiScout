import { AdminOperationsPanel } from "./admin-operations.js";
import { useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { createRoot } from "react-dom/client";
import { CatalogAdmin } from "./admin-catalog.js";
import { AdminCrawls } from "./admin-crawls.js";
import { AdminJobsPanel } from "./admin-jobs.js";
import { CorrectionReportsAdmin } from "./admin-correction-reports.js";
import { ListingAdmin } from "./admin-listings.js";
import { ADMIN_VIEWS, adminLocation, adminViewUrl, isCatalogView } from "./admin-navigation.js";
import type { AdminView } from "./admin-navigation.js";
import { adminWorkCountLabel, useAdminWorkCounts } from "./admin-work-counts.js";

export function AdminConsole() {
  const [location, setLocation] = useState(() => adminLocation(window.location));
  const { counts, refresh: refreshWorkCounts } = useAdminWorkCounts(location.view);
  const workCount = (view: AdminView) =>
    view === "reports" || view === "duplicates" || view === "candidates"
      ? adminWorkCountLabel(counts[view])
      : null;
  const [visited, setVisited] = useState<Set<AdminView>>(() => new Set([location.view]));
  const title = useRef<HTMLHeadingElement>(null);
  const [dataRevision, setDataRevision] = useState(0);
  const [backgroundRevision, setBackgroundRevision] = useState(0);
  const focusNextView = useRef(false);
  const active = ADMIN_VIEWS.find((view) => view.id === location.view)!;
  const catalogView = isCatalogView(location.view) ? location.view : null;
  const listingActive = location.view === "listings" || location.view === "maintenance";

  useEffect(() => {
    const sync = () => {
      const next = adminLocation(window.location);
      setLocation(next);
      setVisited((current) => new Set(current).add(next.view));
    };
    window.addEventListener("popstate", sync);
    window.addEventListener("hashchange", sync);
    return () => {
      window.removeEventListener("popstate", sync);
      window.removeEventListener("hashchange", sync);
    };
  }, []);

  useEffect(() => {
    document.title = `${active.label} | HiFiScout 管理`;
    if (focusNextView.current) {
      title.current?.focus({ preventScroll: true });
      window.scrollTo({ top: 0, behavior: "instant" });
      focusNextView.current = false;
    }
  }, [active]);

  const selectView = (view: AdminView) => {
    if (view === location.view) return;
    window.history.pushState(null, "", adminViewUrl(window.location.href, view));
    focusNextView.current = true;
    setLocation(adminLocation(window.location));
    setVisited((current) => new Set(current).add(view));
  };

  const navigate = (event: MouseEvent<HTMLAnchorElement>, view: AdminView) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
      return;
    event.preventDefault();
    selectView(view);
  };

  return (
    <div className="admin-shell">
      <a
        className="admin-skip-link"
        href="#admin-content"
        onClick={(event) => {
          event.preventDefault();
          document.getElementById("admin-content")?.focus();
          document.getElementById("admin-content")?.scrollIntoView();
        }}
      >
        作業内容へ移動
      </a>
      <aside className="admin-sidebar">
        <a
          className="admin-brand"
          href={adminViewUrl(window.location.href, "catalog")}
          onClick={(event) => navigate(event, "catalog")}
        >
          <img src="/hifiscout-mark.jpg" alt="" width="36" height="36" />
          <span>
            <strong>HiFiScout</strong>
            <small>管理コンソール</small>
          </span>
        </a>
        <nav className="admin-navigation" aria-label="管理メニュー">
          {["日常の管理", "データの整備"].map((group) => (
            <div className="admin-nav-group" key={group}>
              <p>{group}</p>
              {ADMIN_VIEWS.filter((view) => view.group === group).map((view) => (
                <a
                  key={view.id}
                  id={`admin-nav-${view.id}`}
                  href={adminViewUrl(window.location.href, view.id)}
                  aria-current={view.id === location.view ? "page" : undefined}
                  aria-label={view.label}
                  aria-description={
                    workCount(view.id) !== null ? `作業件数 ${workCount(view.id)}` : undefined
                  }
                  onClick={(event) => navigate(event, view.id)}
                >
                  {view.label}
                  {workCount(view.id) !== null ? (
                    <span className="admin-work-count" aria-hidden="true">
                      {workCount(view.id)}
                    </span>
                  ) : (
                    <span className="admin-nav-arrow" aria-hidden="true">
                      ›
                    </span>
                  )}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <label className="admin-mobile-navigation">
          <span>作業を選ぶ</span>
          <select
            value={location.view}
            onChange={(event) => selectView(event.currentTarget.value as AdminView)}
          >
            {["日常の管理", "データの整備"].map((group) => (
              <optgroup key={group} label={group}>
                {ADMIN_VIEWS.filter((view) => view.group === group).map((view) => (
                  <option key={view.id} value={view.id}>
                    {view.label}
                    {workCount(view.id) !== null ? `　${workCount(view.id)}` : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <a
          className="admin-public-link"
          href="https://hifiscout.tokyojp.workers.dev/"
          target="_blank"
          rel="noreferrer"
        >
          検索サイトを開く ↗
        </a>
      </aside>
      <main className="admin-content" id="admin-content" tabIndex={-1}>
        <header className="admin-workspace-heading">
          <p className="admin-breadcrumb">
            管理コンソール <span aria-hidden="true">/</span> {active.group}
          </p>
          <h1 ref={title} tabIndex={-1}>
            {active.label}
          </h1>
          <p>{active.description}</p>
        </header>
        <div hidden={location.view !== "operations"}>
          {visited.has("operations") ? <AdminOperationsPanel /> : null}
        </div>
        <div hidden={location.view !== "jobs"}>
          {visited.has("jobs") ? (
            <AdminJobsPanel
              onDataChanged={() => {
                setBackgroundRevision((value) => value + 1);
                setDataRevision((value) => value + 1);
                refreshWorkCounts();
              }}
            />
          ) : null}
        </div>
        <div hidden={location.view !== "crawls"}>
          {visited.has("crawls") ? <AdminCrawls /> : null}
        </div>
        <div hidden={catalogView === null}>
          {[...visited].some(isCatalogView) ? (
            <CatalogAdmin
              revision={backgroundRevision}
              onDataChanged={() => {
                setDataRevision((value) => value + 1);
                refreshWorkCounts();
              }}
              onWorkCountsChanged={refreshWorkCounts}
              view={catalogView ?? "catalog"}
              active={catalogView !== null}
              search={catalogView ? location.search : ""}
            />
          ) : null}
        </div>
        <div hidden={!listingActive}>
          {visited.has("listings") || visited.has("maintenance") ? (
            <ListingAdmin
              revision={dataRevision}
              view={location.view === "maintenance" ? "maintenance" : "listings"}
              active={listingActive}
              search={listingActive ? location.search : ""}
            />
          ) : null}
        </div>
        <div id="reports-pane" hidden={location.view !== "reports"}>
          {visited.has("reports") ? (
            <CorrectionReportsAdmin onDataChanged={refreshWorkCounts} />
          ) : null}
        </div>
      </main>
    </div>
  );
}

const root = document.getElementById("admin-root");
if (root) createRoot(root).render(<AdminConsole />);
