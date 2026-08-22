export {};

type AdminAppKey = "catalog" | "listings";

interface AdminAppConfig {
  key: AdminAppKey;
  panelId: string;
  scriptSrc: string;
  tabId: string;
}

const APPS: Record<AdminAppKey, AdminAppConfig> = {
  catalog: {
    key: "catalog",
    panelId: "catalog-pane",
    scriptSrc: "/catalog-admin.js",
    tabId: "admin-tab-catalog",
  },
  listings: {
    key: "listings",
    panelId: "listings-pane",
    scriptSrc: "/listing-admin.js",
    tabId: "admin-tab-listings",
  },
};

const loadedApps = new Set<AdminAppKey>();
const loadingApps = new Map<AdminAppKey, Promise<void>>();

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

function requestedTab(): AdminAppKey {
  return window.location.hash === "#listings" ? "listings" : "catalog";
}

function legacyNodes(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("[data-legacy-id]"));
}

function showLoadFailure(config: AdminAppConfig, error: unknown): void {
  const panel = element<HTMLElement>(config.panelId);
  const status = panel.querySelector<HTMLElement>('[data-legacy-id="status-message"]');
  if (!status) return;
  status.dataset.kind = "error";
  status.textContent = `管理画面を読み込めません: ${error instanceof Error ? error.message : String(error)}`;
}

async function loadLegacyApp(config: AdminAppConfig): Promise<void> {
  if (loadedApps.has(config.key)) return;
  const existing = loadingApps.get(config.key);
  if (existing) return existing;

  const request = (async (): Promise<void> => {
    const panel = element<HTMLElement>(config.panelId);
    const nodes = legacyNodes(panel);
    const originalIds = nodes.map((node) => node.id);
    const legacyIds = new Set<string>();

    for (const node of nodes) {
      const legacyId = node.dataset.legacyId;
      if (!legacyId) throw new Error(`Missing data-legacy-id in ${config.panelId}`);
      if (legacyIds.has(legacyId)) throw new Error(`Duplicate legacy id: ${legacyId}`);
      legacyIds.add(legacyId);
      node.id = legacyId;
    }

    try {
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script");
        script.src = config.scriptSrc;
        script.async = false;
        script.dataset.adminApp = config.key;
        script.addEventListener("load", () => resolve(), { once: true });
        script.addEventListener(
          "error",
          () => reject(new Error(`Failed to load ${config.scriptSrc}`)),
          { once: true },
        );
        document.body.appendChild(script);
      });
      loadedApps.add(config.key);
    } finally {
      nodes.forEach((node, index) => {
        node.id = originalIds[index] || "";
      });
    }
  })();

  loadingApps.set(config.key, request);
  try {
    await request;
  } catch (error) {
    showLoadFailure(config, error);
    throw error;
  } finally {
    loadingApps.delete(config.key);
  }
}

function tabUrl(key: AdminAppKey): string {
  const url = new URL(window.location.href);
  url.hash = key === "listings" ? "listings" : "";
  return url.toString();
}

function renderTab(key: AdminAppKey, updateHistory: boolean): void {
  for (const config of Object.values(APPS)) {
    const selected = config.key === key;
    const tab = element<HTMLButtonElement>(config.tabId);
    const panel = element<HTMLElement>(config.panelId);
    tab.setAttribute("aria-selected", selected ? "true" : "false");
    tab.tabIndex = selected ? 0 : -1;
    panel.hidden = !selected;
  }

  if (updateHistory) window.history.pushState(null, "", tabUrl(key));
  void loadLegacyApp(APPS[key]).catch(() => undefined);
}

function focusTab(key: AdminAppKey): void {
  const tab = element<HTMLButtonElement>(APPS[key].tabId);
  tab.focus();
  renderTab(key, true);
}

for (const config of Object.values(APPS)) {
  const tab = element<HTMLButtonElement>(config.tabId);
  tab.addEventListener("click", () => renderTab(config.key, true));
  tab.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      const next: AdminAppKey = config.key === "catalog" ? "listings" : "catalog";
      focusTab(next);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      focusTab("catalog");
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      focusTab("listings");
    }
  });
}

window.addEventListener("popstate", () => renderTab(requestedTab(), false));
renderTab(requestedTab(), false);
