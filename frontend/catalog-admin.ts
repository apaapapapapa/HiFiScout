export {};

type ProductAuditExportScope = "active" | "all";

interface ProductAuditExportJob {
  id: string;
  scope: ProductAuditExportScope;
  status: "queued" | "processing" | "ready" | "failed";
  rowCount: number;
  byteCount: number;
  createdAt: string;
  expiresAt: string | null;
  error: string;
}

interface CategoryFacet {
  id: string;
  name: string;
  classifiable: boolean;
  filterable: boolean;
}

interface CatalogProduct {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  canonicalName: string;
  lifecycleStatus: "unknown" | "active" | "discontinued";
  primaryCategoryId: string;
  matchedListingCount: number;
  updatedAt: string;
}

interface CatalogListResponse {
  items: CatalogProduct[];
  nextAfterId: number | null;
}

interface CatalogUpdateResponse {
  refreshedListings: number;
}

interface ProductAuditExportLatestResponse {
  job: ProductAuditExportJob | null;
}

interface ProductAuditExportElements {
  generate: HTMLButtonElement;
  status: HTMLElement;
  download: HTMLAnchorElement;
}

interface EditSnapshot {
  canonicalName: string;
  primaryCategoryId: string;
  lifecycleStatus: CatalogProduct["lifecycleStatus"];
}

function element<T>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as unknown as T;
}

const controls = element<HTMLElement>("catalog-controls");
const searchForm = element<HTMLFormElement>("catalog-search-form");
const queryInput = element<HTMLInputElement>("catalog-query");
const manufacturerInput = element<HTMLInputElement>("manufacturer-id");
const categoryFilter = element<HTMLSelectElement>("category-filter");
const resetSearch = element<HTMLButtonElement>("reset-search");
const searchSubmit = element<HTMLButtonElement>("search-submit");
const tablePanel = element<HTMLElement>("catalog-table-panel");
const resultSummary = element<HTMLElement>("result-summary");
const rows = element<HTMLTableSectionElement>("catalog-rows");
const emptyState = element<HTMLElement>("empty-state");
const status = element<HTMLElement>("status-message");
const previousButton = element<HTMLButtonElement>("previous-page");
const nextButton = element<HTMLButtonElement>("next-page");
const pagePosition = element<HTMLElement>("page-position");
const dialog = element<HTMLDialogElement>("edit-dialog");
const editForm = element<HTMLFormElement>("edit-form");
const editIdentity = element<HTMLElement>("edit-identity");
const editName = element<HTMLInputElement>("edit-canonical-name");
const editCategory = element<HTMLSelectElement>("edit-category");
const editLifecycle = element<HTMLSelectElement>("edit-lifecycle");
const editChangeStatus = element<HTMLElement>("edit-change-status");
const closeEditButton = element<HTMLButtonElement>("close-edit");
const cancelEdit = element<HTMLButtonElement>("cancel-edit");
const saveEdit = element<HTMLButtonElement>("save-edit");
const productAuditExportElements = {
  active: {
    generate: element<HTMLButtonElement>("export-active-generate"),
    status: element<HTMLElement>("export-active-status"),
    download: element<HTMLAnchorElement>("export-active-download"),
  },
  all: {
    generate: element<HTMLButtonElement>("export-all-generate"),
    status: element<HTMLElement>("export-all-status"),
    download: element<HTMLAnchorElement>("export-all-download"),
  },
} satisfies Record<ProductAuditExportScope, ProductAuditExportElements>;

const PRODUCT_AUDIT_EXPORT_SCOPES = ["active", "all"] as const;
const PRODUCT_AUDIT_EXPORT_POLL_MS = 5_000;

let categories: CategoryFacet[] = [];
let currentAfterId = 0;
let nextAfterId: number | null = null;
let history: number[] = [];
let editingId: number | null = null;
let editingSnapshot: EditSnapshot | null = null;
let busy = false;
let saving = false;
let catalogReady = false;
let productAuditExportPollTimer: number | null = null;
const productAuditExportJobs: Record<ProductAuditExportScope, ProductAuditExportJob | null> = {
  active: null,
  all: null,
};
const productAuditExportBusy: Record<ProductAuditExportScope, boolean> = {
  active: true,
  all: true,
};

function message(value: string, kind: "info" | "error" | "success" = "info"): void {
  status.textContent = value;
  status.dataset.kind = kind;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hasActiveFilters(): boolean {
  return Boolean(queryInput.value.trim() || manufacturerInput.value.trim() || categoryFilter.value);
}

function editIsDirty(): boolean {
  if (!editingSnapshot) return false;
  return (
    editName.value.trim() !== editingSnapshot.canonicalName ||
    editCategory.value !== editingSnapshot.primaryCategoryId ||
    editLifecycle.value !== editingSnapshot.lifecycleStatus
  );
}

function updateInteractionState(): void {
  previousButton.disabled = busy || history.length === 0;
  nextButton.disabled = busy || nextAfterId === null;
  searchSubmit.disabled = busy;
  resetSearch.disabled = busy || !hasActiveFilters();
  tablePanel.classList.toggle("is-loading", busy);
  tablePanel.setAttribute("aria-busy", busy ? "true" : "false");

  const dirty = editIsDirty();
  saveEdit.disabled = busy || saving || !dirty;
  saveEdit.textContent = saving ? "保存中…" : "変更を保存";
  if (editingSnapshot) {
    editChangeStatus.dataset.dirty = dirty ? "true" : "false";
    editChangeStatus.textContent = dirty ? "未保存の変更があります。" : "変更すると保存できます。";
  }
}

function setBusy(value: boolean): void {
  busy = value;
  updateInteractionState();
}

async function json<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A status code is still enough to surface a useful failure.
  }
  if (!response.ok) {
    const code =
      body &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as { error?: unknown }).error === "string"
        ? String((body as { error: string }).error)
        : `HTTP ${response.status}`;
    throw new Error(code);
  }
  return body as T;
}

async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  return json<T>(
    await fetch(path, { ...init, headers, cache: "no-store", credentials: "same-origin" }),
  );
}

function productAuditExportDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function productAuditExportBytes(value: number): string {
  if (value < 1_024) return `${value.toLocaleString("ja-JP")} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function productAuditExportExpired(job: ProductAuditExportJob): boolean {
  if (job.status !== "ready" || !job.expiresAt) return false;
  const expiresAt = Date.parse(job.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function productAuditExportActive(job: ProductAuditExportJob | null): boolean {
  return job?.status === "queued" || job?.status === "processing";
}

function productAuditExportFailureMessage(error: string): string {
  if (error === "product_audit_export_too_large") {
    return "225,000件の上限を超えました。対象を掲載中商品に絞ってください。";
  }
  if (error === "product_audit_export_generation_deadline_exceeded") {
    return "24時間の生成期限を超えました。もう一度生成してください。";
  }
  if (error === "queue_delivery_exhausted") {
    return "バックグラウンド処理の再試行上限に達しました。もう一度生成してください。";
  }
  return error;
}

function renderProductAuditExport(scope: ProductAuditExportScope): void {
  const elements = productAuditExportElements[scope];
  const job = productAuditExportJobs[scope];
  const active = productAuditExportActive(job);
  const expired = job ? productAuditExportExpired(job) : false;

  elements.generate.disabled = productAuditExportBusy[scope] || active;
  elements.generate.textContent = productAuditExportBusy[scope]
    ? "受付中…"
    : active
      ? "生成中…"
      : job
        ? "再生成"
        : "CSVを生成";
  elements.download.hidden = !job || job.status !== "ready" || expired;
  if (!elements.download.hidden && job) {
    elements.download.href = `/api/admin/product-audit-exports/${encodeURIComponent(job.id)}/download`;
  } else {
    elements.download.removeAttribute("href");
  }

  elements.status.dataset.kind = "info";
  if (!job) {
    elements.status.textContent = "まだ生成されていません。";
    return;
  }
  if (job.status === "queued") {
    elements.status.textContent = job.rowCount
      ? `${job.rowCount.toLocaleString("ja-JP")}件を生成済みです。次のバッチを待っています…`
      : `生成待ちです（受付: ${productAuditExportDate(job.createdAt)}）。`;
    return;
  }
  if (job.status === "processing") {
    elements.status.textContent = `${job.rowCount.toLocaleString("ja-JP")}件を生成済みです。負荷を抑えながら処理しています…`;
    return;
  }
  if (job.status === "failed") {
    elements.status.dataset.kind = "error";
    elements.status.textContent = job.error
      ? `生成に失敗しました: ${productAuditExportFailureMessage(job.error)}`
      : "生成に失敗しました。もう一度お試しください。";
    return;
  }
  if (expired) {
    elements.status.dataset.kind = "error";
    elements.status.textContent = "ダウンロード期限が切れました。もう一度生成してください。";
    return;
  }

  elements.status.dataset.kind = "success";
  elements.status.textContent = `${job.rowCount.toLocaleString("ja-JP")}件（${productAuditExportBytes(job.byteCount)}）の生成が完了しました。有効期限: ${productAuditExportDate(job.expiresAt)}`;
}

function renderProductAuditExportError(
  scope: ProductAuditExportScope,
  error: unknown,
  action = "生成状況を確認",
): void {
  renderProductAuditExport(scope);
  const status = productAuditExportElements[scope].status;
  status.dataset.kind = "error";
  status.textContent = `CSVの${action}できません: ${errorText(error)}`;
}

async function loadLatestProductAuditExport(
  scope: ProductAuditExportScope,
  releaseInitialLock = false,
): Promise<void> {
  let failure: unknown = null;
  try {
    const result = await adminJson<ProductAuditExportLatestResponse>(
      `/api/admin/product-audit-exports?scope=${scope}`,
    );
    productAuditExportJobs[scope] = result.job;
  } catch (error) {
    failure = error;
  } finally {
    if (releaseInitialLock) productAuditExportBusy[scope] = false;
  }

  if (failure) {
    renderProductAuditExportError(scope, failure);
  } else {
    renderProductAuditExport(scope);
  }
}

function scheduleProductAuditExportPoll(): void {
  if (productAuditExportPollTimer !== null) {
    window.clearTimeout(productAuditExportPollTimer);
    productAuditExportPollTimer = null;
  }
  if (
    !PRODUCT_AUDIT_EXPORT_SCOPES.some((scope) =>
      productAuditExportActive(productAuditExportJobs[scope]),
    )
  ) {
    return;
  }
  productAuditExportPollTimer = window.setTimeout(() => {
    productAuditExportPollTimer = null;
    void pollProductAuditExports();
  }, PRODUCT_AUDIT_EXPORT_POLL_MS);
}

async function pollProductAuditExports(): Promise<void> {
  const scopes = PRODUCT_AUDIT_EXPORT_SCOPES.filter((scope) =>
    productAuditExportActive(productAuditExportJobs[scope]),
  );
  await Promise.all(scopes.map((scope) => loadLatestProductAuditExport(scope)));
  scheduleProductAuditExportPoll();
}

async function loadProductAuditExports(): Promise<void> {
  await Promise.all(
    PRODUCT_AUDIT_EXPORT_SCOPES.map((scope) => loadLatestProductAuditExport(scope, true)),
  );
  scheduleProductAuditExportPoll();
}

async function generateProductAuditExport(scope: ProductAuditExportScope): Promise<void> {
  if (productAuditExportBusy[scope] || productAuditExportActive(productAuditExportJobs[scope]))
    return;
  productAuditExportBusy[scope] = true;
  renderProductAuditExport(scope);
  let failure: unknown = null;
  try {
    productAuditExportJobs[scope] = await adminJson<ProductAuditExportJob>(
      "/api/admin/product-audit-exports",
      {
        method: "POST",
        body: JSON.stringify({ scope }),
      },
    );
  } catch (error) {
    failure = error;
  } finally {
    productAuditExportBusy[scope] = false;
  }

  if (failure) {
    renderProductAuditExportError(scope, failure, "生成を開始");
  } else {
    renderProductAuditExport(scope);
  }
  scheduleProductAuditExportPoll();
}

function categoryName(id: string): string {
  return categories.find((category) => category.id === id)?.name.trim() || id || "—";
}

function lifecycleName(value: CatalogProduct["lifecycleStatus"]): string {
  return value === "active" ? "現行" : value === "discontinued" ? "生産完了" : "不明";
}

function lifecycleClass(value: CatalogProduct["lifecycleStatus"]): string {
  return value === "active"
    ? "lifecycle-active"
    : value === "discontinued"
      ? "lifecycle-discontinued"
      : "lifecycle-unknown";
}

function cell(row: HTMLTableRowElement, label: string, value: string, className = ""): void {
  const td = document.createElement("td");
  td.dataset.label = label;
  td.textContent = value;
  if (className) td.className = className;
  row.appendChild(td);
}

function badgeCell(
  row: HTMLTableRowElement,
  label: string,
  value: string,
  className: string,
): void {
  const td = document.createElement("td");
  td.dataset.label = label;
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = value;
  badge.title = value;
  td.appendChild(badge);
  row.appendChild(td);
}

function openEdit(product: CatalogProduct): void {
  editingId = product.id;
  editingSnapshot = {
    canonicalName: product.canonicalName,
    primaryCategoryId: product.primaryCategoryId,
    lifecycleStatus: product.lifecycleStatus,
  };
  editIdentity.textContent = `${product.manufacturerId} / ${product.canonicalModel} (#${product.id})`;
  editName.value = product.canonicalName;
  editCategory.value = product.primaryCategoryId;
  editLifecycle.value = product.lifecycleStatus;
  dialog.showModal();
  updateInteractionState();
  requestAnimationFrame(() => {
    editName.focus();
    editName.select();
  });
}

function render(items: CatalogProduct[]): void {
  rows.replaceChildren();
  emptyState.hidden = items.length !== 0;
  for (const product of items) {
    const row = document.createElement("tr");
    row.dataset.catalogId = String(product.id);
    cell(row, "ID", String(product.id), "id-cell");
    cell(row, "メーカー", product.manufacturerId);
    cell(row, "型番", product.canonicalModel, "model-cell");
    cell(row, "表示名", product.canonicalName, "name-cell");
    badgeCell(
      row,
      "カテゴリ",
      categoryName(product.primaryCategoryId),
      "category-badge",
    );
    badgeCell(
      row,
      "状態",
      lifecycleName(product.lifecycleStatus),
      `lifecycle-badge ${lifecycleClass(product.lifecycleStatus)}`,
    );
    badgeCell(row, "listing", String(product.matchedListingCount), "count-badge");
    cell(
      row,
      "更新日時",
      product.updatedAt ? new Date(product.updatedAt).toLocaleString("ja-JP") : "—",
      "updated-cell",
    );
    const action = document.createElement("td");
    action.dataset.label = "操作";
    action.className = "row-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button compact";
    button.textContent = "編集";
    button.setAttribute("aria-label", `${product.canonicalName} を編集`);
    button.addEventListener("click", () => openEdit(product));
    action.appendChild(button);
    row.appendChild(action);
    rows.appendChild(row);
  }
}

function params(afterId: number): URLSearchParams {
  const value = new URLSearchParams({ limit: "50" });
  if (queryInput.value.trim()) value.set("q", queryInput.value.trim());
  if (manufacturerInput.value.trim())
    value.set("manufacturerId", manufacturerInput.value.trim().toLowerCase());
  if (categoryFilter.value) value.set("categoryId", categoryFilter.value);
  if (afterId) value.set("afterId", String(afterId));
  return value;
}

function updateResultSummary(itemCount: number): void {
  const filters: string[] = [];
  if (queryInput.value.trim()) filters.push(`検索「${queryInput.value.trim()}」`);
  if (manufacturerInput.value.trim()) filters.push(`メーカー ${manufacturerInput.value.trim()}`);
  if (categoryFilter.value) filters.push(categoryName(categoryFilter.value));
  resultSummary.textContent = filters.length
    ? `${itemCount}件表示 · ${filters.join(" · ")}`
    : `${itemCount}件表示 · すべてのCatalog`;
}

async function load(afterId: number, resetHistory = false): Promise<void> {
  if (busy) return;
  setBusy(true);
  message("Catalogを読み込んでいます…");
  try {
    const result = await adminJson<CatalogListResponse>(
      `/api/admin/knowledge-catalog/products?${params(afterId)}`,
    );
    currentAfterId = afterId;
    nextAfterId = result.nextAfterId;
    if (resetHistory) history = [];
    render(result.items);
    updateResultSummary(result.items.length);
    catalogReady = true;
    controls.hidden = false;
    pagePosition.textContent = `ページ ${history.length + 1}`;
    message("");
  } catch (error) {
    if (!catalogReady) controls.hidden = true;
    message(`Catalogを読み込めません: ${errorText(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function addOption(select: HTMLSelectElement, category: CategoryFacet): void {
  const option = document.createElement("option");
  option.value = category.id;
  option.textContent = category.name;
  select.appendChild(option);
}

async function loadCategories(): Promise<void> {
  const meta = await adminJson<{ categoryFacets: CategoryFacet[] }>("/api/meta");
  categories = meta.categoryFacets;
  categoryFilter.replaceChildren(new Option("すべてのカテゴリ", ""));
  editCategory.replaceChildren();
  for (const category of categories) {
    if (category.filterable) addOption(categoryFilter, category);
    if (category.classifiable) addOption(editCategory, category);
  }
}

async function save(): Promise<void> {
  if (editingId === null || busy || !editIsDirty()) return;
  const canonicalName = editName.value.trim();
  const primaryCategoryId = editCategory.value;
  if (!canonicalName || !primaryCategoryId) {
    message("表示名とカテゴリは必須です。", "error");
    return;
  }
  saving = true;
  setBusy(true);
  try {
    const result = await adminJson<CatalogUpdateResponse>(
      `/api/admin/knowledge-catalog/products/${editingId}`,
      {
        method: "PATCH",
        body: JSON.stringify({
          canonicalName,
          primaryCategoryId,
          lifecycleStatus: editLifecycle.value,
        }),
      },
    );
    dialog.close();
    editingId = null;
    editingSnapshot = null;
    saving = false;
    setBusy(false);
    await load(currentAfterId);
    message(
      `保存しました。紐づく${result.refreshedListings}件のlistingを再投影しました。`,
      "success",
    );
  } catch (error) {
    saving = false;
    message(`保存できません: ${errorText(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function clearFilters(): void {
  queryInput.value = "";
  manufacturerInput.value = "";
  categoryFilter.value = "";
  history = [];
  updateInteractionState();
  void load(0, true);
  queryInput.focus();
}

function closeEditDialog(): void {
  dialog.close();
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  history = [];
  void load(0, true);
});
resetSearch.addEventListener("click", clearFilters);
for (const control of [queryInput, manufacturerInput, categoryFilter]) {
  control.addEventListener("input", updateInteractionState);
  control.addEventListener("change", updateInteractionState);
}
previousButton.addEventListener("click", () => {
  const previous = history.pop();
  if (previous !== undefined) void load(previous);
});
nextButton.addEventListener("click", () => {
  if (nextAfterId === null) return;
  history.push(currentAfterId);
  void load(nextAfterId);
});
closeEditButton.addEventListener("click", closeEditDialog);
cancelEdit.addEventListener("click", closeEditDialog);
dialog.addEventListener("cancel", (event) => {
  if (!editIsDirty()) return;
  event.preventDefault();
  editChangeStatus.dataset.dirty = "warning";
  editChangeStatus.textContent = "未保存の変更があります。キャンセルで破棄できます。";
});
dialog.addEventListener("close", () => {
  editingId = null;
  editingSnapshot = null;
  saving = false;
  updateInteractionState();
});
for (const control of [editName, editCategory, editLifecycle]) {
  control.addEventListener("input", updateInteractionState);
  control.addEventListener("change", updateInteractionState);
}
editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});
for (const scope of PRODUCT_AUDIT_EXPORT_SCOPES) {
  productAuditExportElements[scope].generate.addEventListener("click", () => {
    void generateProductAuditExport(scope);
  });
}

async function start(): Promise<void> {
  void loadProductAuditExports();
  try {
    await loadCategories();
    updateInteractionState();
    await load(0, true);
  } catch (error) {
    message(`管理画面を初期化できません: ${errorText(error)}`, "error");
  }
}

void start();
