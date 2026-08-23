export {};

type AdminAppKey = "catalog" | "listings";

interface AdminAppConfig {
  key: AdminAppKey;
  panelId: string;
  scriptSrcs: readonly string[];
  fragmentSrc: string;
  selectors: readonly string[];
  tabId: string;
}

const APPS: Record<AdminAppKey, AdminAppConfig> = {
  catalog: {
    key: "catalog",
    panelId: "catalog-pane",
    scriptSrcs: ["/catalog-admin.js", "/catalog-admin-operations.js"],
    fragmentSrc: "/catalog-admin.html",
    selectors: ["#status-message", "#catalog-controls", "#edit-dialog"],
    tabId: "admin-tab-catalog",
  },
  listings: {
    key: "listings",
    panelId: "listings-pane",
    scriptSrcs: ["/listing-admin.js"],
    fragmentSrc: "/listing-admin.html",
    selectors: ["#status-message", "#listing-controls", "#edit-dialog"],
    tabId: "admin-tab-listings",
  },
};

const mountedApps = new Set<AdminAppKey>();
const loadedApps = new Set<AdminAppKey>();
const loadingApps = new Map<AdminAppKey, Promise<void>>();
let legacyScriptQueue: Promise<void> = Promise.resolve();

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

function requestedTab(): AdminAppKey {
  return window.location.hash === "#listings" ? "listings" : "catalog";
}

function loadStatus(panel: HTMLElement): HTMLElement {
  const value = panel.querySelector<HTMLElement>("[data-admin-load-status]");
  if (!value) throw new Error(`Missing load status in #${panel.id}`);
  return value;
}

function mountPoint(panel: HTMLElement): HTMLElement {
  const value = panel.querySelector<HTMLElement>("[data-admin-mount]");
  if (!value) throw new Error(`Missing mount point in #${panel.id}`);
  return value;
}

function rewriteIdReferences(root: ParentNode, ids: Map<string, string>): void {
  const tokenAttributes = ["for", "aria-labelledby", "aria-describedby", "aria-controls"] as const;
  for (const node of root.querySelectorAll<HTMLElement>("*")) {
    for (const attribute of tokenAttributes) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      node.setAttribute(
        attribute,
        value
          .split(/\s+/u)
          .map((token) => ids.get(token) || token)
          .join(" "),
      );
    }
    const href = node.getAttribute("href");
    if (href?.startsWith("#")) {
      const replacement = ids.get(href.slice(1));
      if (replacement) node.setAttribute("href", `#${replacement}`);
    }
  }
}

function namespaceFragment(root: ParentNode, key: AdminAppKey): void {
  const ids = new Map<string, string>();
  for (const node of root.querySelectorAll<HTMLElement>("[id]")) {
    const legacyId = node.id;
    const namespacedId = `${key}-${legacyId}`;
    node.dataset.legacyId = legacyId;
    node.id = namespacedId;
    ids.set(legacyId, namespacedId);
  }
  rewriteIdReferences(root, ids);
}

async function mountFragment(config: AdminAppConfig): Promise<void> {
  if (mountedApps.has(config.key)) return;
  const panel = element<HTMLElement>(config.panelId);
  const status = loadStatus(panel);
  status.hidden = false;
  status.dataset.kind = "info";
  status.textContent = "管理機能を読み込んでいます…";

  const response = await fetch(config.fragmentSrc, {
    cache: "no-store",
    credentials: "same-origin",
    headers: { "x-admin-fragment": "1" },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const source = new DOMParser().parseFromString(await response.text(), "text/html");
  const fragment = document.createDocumentFragment();
  for (const selector of config.selectors) {
    const node = source.querySelector(selector);
    if (!node) throw new Error(`Missing ${selector} in ${config.fragmentSrc}`);
    fragment.appendChild(document.importNode(node, true));
  }
  namespaceFragment(fragment, config.key);
  mountPoint(panel).replaceChildren(fragment);
  mountedApps.add(config.key);
  status.hidden = true;
  status.textContent = "";
}

function legacyNodes(panel: HTMLElement): HTMLElement[] {
  return Array.from(panel.querySelectorAll<HTMLElement>("[data-legacy-id]"));
}

function showLoadFailure(config: AdminAppConfig, error: unknown): void {
  const panel = element<HTMLElement>(config.panelId);
  const status = loadStatus(panel);
  status.hidden = false;
  status.dataset.kind = "error";
  status.textContent = `管理画面を読み込めません: ${error instanceof Error ? error.message : String(error)}`;
}

function appendLegacyScript(config: AdminAppConfig, scriptSrc: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = scriptSrc;
    script.async = false;
    script.dataset.adminApp = config.key;
    script.dataset.adminFeature = scriptSrc;
    script.addEventListener("load", () => resolve(), { once: true });
    script.addEventListener("error", () => reject(new Error(`Failed to load ${scriptSrc}`)), {
      once: true,
    });
    document.body.appendChild(script);
  });
}

async function initializeLegacyScripts(config: AdminAppConfig): Promise<void> {
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

  // Every feature for one fragment must bind while the fragment exposes its original IDs.
  try {
    for (const scriptSrc of config.scriptSrcs) {
      await appendLegacyScript(config, scriptSrc);
    }
    loadedApps.add(config.key);
  } finally {
    nodes.forEach((node, index) => {
      node.id = originalIds[index] || "";
    });
  }
}

function queueLegacyScripts(config: AdminAppConfig): Promise<void> {
  const run = legacyScriptQueue.then(() => initializeLegacyScripts(config));
  legacyScriptQueue = run.catch(() => undefined);
  return run;
}

async function loadLegacyApp(config: AdminAppConfig): Promise<void> {
  if (loadedApps.has(config.key)) return;
  const existing = loadingApps.get(config.key);
  if (existing) return existing;

  const request = (async (): Promise<void> => {
    await mountFragment(config);
    await queueLegacyScripts(config);
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
      focusTab(config.key === "catalog" ? "listings" : "catalog");
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
