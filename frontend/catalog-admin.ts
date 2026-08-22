export {};

const CSV_EXPORT_KEYS = ["catalog", "product-audit-active", "product-audit-all"] as const;
type CsvExportKey = (typeof CSV_EXPORT_KEYS)[number];

interface CsvExportJob {
  id: string;
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

interface CsvExportLatestResponse {
  job: CsvExportJob | null;
}

interface CsvExportElements {
  generate: HTMLButtonElement;
  status: HTMLElement;
  download: HTMLAnchorElement;
}

interface CsvExportTarget {
  collectionUrl: string;
  latestUrl: string;
  startBody: object;
  downloadUrl(jobId: string): string;
  elements: CsvExportElements;
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
const cancelEdit = element<HTMLButtonElement>("cancel-edit");
const saveEdit = element<HTMLButtonElement>("save-edit");
const csvExportTargets = {
  catalog: {
    collectionUrl: "/api/admin/knowledge-catalog-exports",
    latestUrl: "/api/admin/knowledge-catalog-exports",
    startBody: {},
    downloadUrl: (jobId) =>
      `/api/admin/knowledge-catalog-exports/${encodeURIComponent(jobId)}/download`,
    elements: {
      generate: element<HTMLButtonElement>("export-catalog-generate"),
      status: element<HTMLElement>("export-catalog-status"),
      download: element<HTMLAnchorElement>("export-catalog-download"),
    },
  },
  "product-audit-active": {
    collectionUrl: "/api/admin/product-audit-exports",
    latestUrl: "/api/admin/product-audit-exports?scope=active",
    startBody: { scope: "active" },
    downloadUrl: (jobId) =>
      `/api/admin/product-audit-exports/${encodeURIComponent(jobId)}/download`,
    elements: {
      generate: element<HTMLButtonElement>("export-active-generate"),
      status: element<HTMLElement>("export-active-status"),
      download: element<HTMLAnchorElement>("export-active-download"),
    },
  },
  "product-audit-all": {
    collectionUrl: "/api/admin/product-audit-exports",
    latestUrl: "/api/admin/product-audit-exports?scope=all",
    startBody: { scope: "all" },
    downloadUrl: (jobId) =>
      `/api/admin/product-audit-exports/${encodeURIComponent(jobId)}/download`,
    elements: {
      generate: element<HTMLButtonElement>("export-all-generate"),
      status: element<HTMLElement>("export-all-status"),
      download: element<HTMLAnchorElement>("export-all-download"),
    },
  },
} satisfies Record<CsvExportKey, CsvExportTarget>;

const CSV_EXPORT_POLL_MS = 5_000;

let categories: CategoryFacet[] = [];
let currentAfterId = 0;
let nextAfterId: number | null = null;
let history: number[] = [];
let editingId: number | null = null;
let busy = false;
let csvExportPollTimer: number | null = null;
const csvExportJobs: Record<CsvExportKey, CsvExportJob | null> = {
  catalog: null,
  "product-audit-active": null,
  "product-audit-all": null,
};
const csvExportBusy: Record<CsvExportKey, boolean> = {
  catalog: true,
  "product-audit-active": true,
  "product-audit-all": true,
};
const csvExportRequestEpoch: Record<CsvExportKey, number> = {
  catalog: 0,
  "product-audit-active": 0,
  "product-audit-all": 0,
};
const csvExportLatestInFlight: Record<CsvExportKey, Promise<void> | null> = {
  catalog: null,
  "product-audit-active": null,
  "product-audit-all": null,
};

function message(value: string, kind: "info" | "error" | "success" = "info"): void {
  status.textContent = value;
  status.dataset.kind = kind;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setBusy(value: boolean): void {
  busy = value;
  previousButton.disabled = value || history.length === 0;
  nextButton.disabled = value || nextAfterId === null;
  saveEdit.disabled = value;
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

function csvExportDate(value: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function csvExportBytes(value: number): string {
  if (value < 1_024) return `${value.toLocaleString("ja-JP")} B`;
  if (value < 1_024 * 1_024) return `${(value / 1_024).toFixed(1)} KB`;
  return `${(value / (1_024 * 1_024)).toFixed(1)} MB`;
}

function csvExportExpired(job: CsvExportJob): boolean {
  if (job.status !== "ready" || !job.expiresAt) return false;
  const expiresAt = Date.parse(job.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function csvExportActive(job: CsvExportJob | null): boolean {
  return job?.status === "queued" || job?.status === "processing";
}

function csvExportFailureMessage(error: string): string {
  if (error === "product_audit_export_too_large") {
    return "225,000件の上限を超えました。対象を掲載中商品に絞ってください。";
  }
  if (error === "knowledge_catalog_export_too_large") {
    return "90,000件の上限を超えました。";
  }
  if (
    error === "product_audit_export_generation_deadline_exceeded" ||
    error === "knowledge_catalog_export_generation_deadline_exceeded"
  ) {
    return "24時間の生成期限を超えました。もう一度生成してください。";
  }
  if (error === "queue_delivery_exhausted") {
    return "バックグラウンド処理の再試行上限に達しました。もう一度生成してください。";
  }
  return error;
}

function renderCsvExport(key: CsvExportKey): void {
  const target = csvExportTargets[key];
  const elements = target.elements;
  const job = csvExportJobs[key];
  const active = csvExportActive(job);
  const expired = job ? csvExportExpired(job) : false;

  elements.generate.disabled = csvExportBusy[key] || active;
  elements.generate.textContent = csvExportBusy[key]
    ? "受付中…"
    : active
      ? "生成中…"
      : job
        ? "再生成"
        : "CSVを生成";
  elements.download.hidden = !job || job.status !== "ready" || expired;
  if (!elements.download.hidden && job) {
    elements.download.href = target.downloadUrl(job.id);
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
      : `生成待ちです（受付: ${csvExportDate(job.createdAt)}）。`;
    return;
  }
  if (job.status === "processing") {
    elements.status.textContent = `${job.rowCount.toLocaleString("ja-JP")}件を生成済みです。負荷を抑えながら処理しています…`;
    return;
  }
  if (job.status === "failed") {
    elements.status.dataset.kind = "error";
    elements.status.textContent = job.error
      ? `生成に失敗しました: ${csvExportFailureMessage(job.error)}`
      : "生成に失敗しました。もう一度お試しください。";
    return;
  }
  if (expired) {
    elements.status.dataset.kind = "error";
    elements.status.textContent = "ダウンロード期限が切れました。もう一度生成してください。";
    return;
  }

  elements.status.dataset.kind = "success";
  elements.status.textContent = `${job.rowCount.toLocaleString("ja-JP")}件（${csvExportBytes(job.byteCount)}）の生成が完了しました。有効期限: ${csvExportDate(job.expiresAt)}`;
}

function renderCsvExportError(key: CsvExportKey, error: unknown, action = "生成状況を確認"): void {
  renderCsvExport(key);
  const status = csvExportTargets[key].elements.status;
  status.dataset.kind = "error";
  status.textContent = `CSVの${action}できません: ${errorText(error)}`;
}

async function loadLatestCsvExport(key: CsvExportKey, releaseInitialLock = false): Promise<void> {
  const existing = csvExportLatestInFlight[key];
  if (existing) {
    await existing;
    return;
  }

  const epoch = csvExportRequestEpoch[key];
  const request = (async (): Promise<void> => {
    let failure: unknown = null;
    try {
      const result = await adminJson<CsvExportLatestResponse>(csvExportTargets[key].latestUrl);
      if (csvExportRequestEpoch[key] === epoch) csvExportJobs[key] = result.job;
    } catch (error) {
      failure = error;
    } finally {
      if (releaseInitialLock && csvExportRequestEpoch[key] === epoch) {
        csvExportBusy[key] = false;
      }
    }

    if (csvExportRequestEpoch[key] !== epoch) return;
    if (failure) {
      renderCsvExportError(key, failure);
    } else {
      renderCsvExport(key);
    }
  })();
  csvExportLatestInFlight[key] = request;
  try {
    await request;
  } finally {
    if (csvExportLatestInFlight[key] === request) csvExportLatestInFlight[key] = null;
  }
}

function scheduleCsvExportPoll(): void {
  if (csvExportPollTimer !== null) {
    window.clearTimeout(csvExportPollTimer);
    csvExportPollTimer = null;
  }
  if (!CSV_EXPORT_KEYS.some((key) => csvExportActive(csvExportJobs[key]))) {
    return;
  }
  csvExportPollTimer = window.setTimeout(() => {
    csvExportPollTimer = null;
    void pollCsvExports();
  }, CSV_EXPORT_POLL_MS);
}

async function pollCsvExports(): Promise<void> {
  const keys = CSV_EXPORT_KEYS.filter((key) => csvExportActive(csvExportJobs[key]));
  await Promise.all(keys.map((key) => loadLatestCsvExport(key)));
  scheduleCsvExportPoll();
}

async function loadCsvExports(): Promise<void> {
  await Promise.all(CSV_EXPORT_KEYS.map((key) => loadLatestCsvExport(key, true)));
  scheduleCsvExportPoll();
}

async function generateCsvExport(key: CsvExportKey): Promise<void> {
  if (csvExportBusy[key] || csvExportActive(csvExportJobs[key])) return;
  const epoch = ++csvExportRequestEpoch[key];
  csvExportBusy[key] = true;
  renderCsvExport(key);
  let failure: unknown = null;
  try {
    const target = csvExportTargets[key];
    const job = await adminJson<CsvExportJob>(target.collectionUrl, {
      method: "POST",
      body: JSON.stringify(target.startBody),
    });
    if (csvExportRequestEpoch[key] === epoch) csvExportJobs[key] = job;
  } catch (error) {
    failure = error;
  } finally {
    if (csvExportRequestEpoch[key] === epoch) csvExportBusy[key] = false;
  }

  if (csvExportRequestEpoch[key] !== epoch) return;
  if (failure) {
    renderCsvExportError(key, failure, "生成を開始");
  } else {
    renderCsvExport(key);
  }
  scheduleCsvExportPoll();
}

function categoryName(id: string): string {
  return categories.find((category) => category.id === id)?.name.trim() || id || "—";
}

function lifecycleName(value: CatalogProduct["lifecycleStatus"]): string {
  return value === "active" ? "現行" : value === "discontinued" ? "生産完了" : "不明";
}

function cell(row: HTMLTableRowElement, value: string): void {
  const td = document.createElement("td");
  td.textContent = value;
  row.appendChild(td);
}

function openEdit(product: CatalogProduct): void {
  editingId = product.id;
  editIdentity.textContent = `${product.manufacturerId} / ${product.canonicalModel} (#${product.id})`;
  editName.value = product.canonicalName;
  editCategory.value = product.primaryCategoryId;
  editLifecycle.value = product.lifecycleStatus;
  dialog.showModal();
}

function render(items: CatalogProduct[]): void {
  rows.replaceChildren();
  emptyState.hidden = items.length !== 0;
  for (const product of items) {
    const row = document.createElement("tr");
    cell(row, String(product.id));
    cell(row, product.manufacturerId);
    cell(row, product.canonicalModel);
    cell(row, product.canonicalName);
    cell(row, categoryName(product.primaryCategoryId));
    cell(row, lifecycleName(product.lifecycleStatus));
    cell(row, String(product.matchedListingCount));
    cell(row, product.updatedAt ? new Date(product.updatedAt).toLocaleString("ja-JP") : "—");
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button compact";
    button.textContent = "編集";
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
    controls.hidden = false;
    pagePosition.textContent = afterId ? `ID ${afterId} より後` : "先頭";
    message(`${result.items.length}件を表示しています。`, "success");
  } catch (error) {
    controls.hidden = true;
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
  if (editingId === null || busy) return;
  const canonicalName = editName.value.trim();
  const primaryCategoryId = editCategory.value;
  if (!canonicalName || !primaryCategoryId) {
    message("表示名とカテゴリは必須です。", "error");
    return;
  }
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
    setBusy(false);
    await load(currentAfterId);
    message(
      `保存しました。紐づく${result.refreshedListings}件のlistingを再投影しました。`,
      "success",
    );
  } catch (error) {
    message(`保存できません: ${errorText(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  history = [];
  void load(0, true);
});
previousButton.addEventListener("click", () => {
  const previous = history.pop();
  if (previous !== undefined) void load(previous);
});
nextButton.addEventListener("click", () => {
  if (nextAfterId === null) return;
  history.push(currentAfterId);
  void load(nextAfterId);
});
cancelEdit.addEventListener("click", () => {
  editingId = null;
  dialog.close();
});
editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void save();
});
for (const key of CSV_EXPORT_KEYS) {
  csvExportTargets[key].elements.generate.addEventListener("click", () => {
    void generateCsvExport(key);
  });
}

async function start(): Promise<void> {
  void loadCsvExports();
  try {
    await loadCategories();
    await load(0, true);
  } catch (error) {
    message(`管理画面を初期化できません: ${errorText(error)}`, "error");
  }
}

void start();
