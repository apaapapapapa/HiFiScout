export {};

interface CategoryFacet {
  id: string;
  name: string;
  classifiable: boolean;
  filterable: boolean;
}

interface ListingOverrides {
  manufacturerId: string | null;
  model: string | null;
  primaryCategoryId: string | null;
  updatedAt: string | null;
}

interface ListingProduct {
  id: number;
  shopKey: string;
  sourceId: string;
  sourceUrl: string;
  isActive: boolean;
  stockStatus: string;
  priceYen: number | null;
  title: string;
  rawManufacturer: string;
  manufacturer: string;
  manufacturerId: string;
  canonicalManufacturerId: string;
  rawModel: string;
  model: string;
  normalizedModel: string;
  rawCategory: string;
  category: string;
  primaryCategoryId: string;
  classificationStatus: string;
  lastSeenAt: string;
  lastChangedAt: string;
  lastActivityAt: string;
  overrides: ListingOverrides;
}

interface ListingListResponse {
  items: ListingProduct[];
  nextAfterId: number | null;
  hasMore: boolean;
}

interface ListingUpdateResponse {
  listing: ListingProduct;
  refreshedListings: number;
}

interface MetaResponse {
  categoryFacets: CategoryFacet[];
}

interface EditSnapshot {
  manufacturerId: string;
  model: string;
  primaryCategoryId: string;
}

function element<T>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as unknown as T;
}

const controls = element<HTMLElement>("listing-controls");
const searchForm = element<HTMLFormElement>("listing-search-form");
const queryInput = element<HTMLInputElement>("listing-query");
const shopKeyInput = element<HTMLInputElement>("shop-key");
const categoryFilter = element<HTMLSelectElement>("category-filter");
const scopeFilter = element<HTMLSelectElement>("listing-scope");
const resetSearch = element<HTMLButtonElement>("reset-search");
const searchSubmit = element<HTMLButtonElement>("search-submit");
const tablePanel = element<HTMLElement>("listing-table-panel");
const resultSummary = element<HTMLElement>("result-summary");
const rows = element<HTMLTableSectionElement>("listing-rows");
const emptyState = element<HTMLElement>("empty-state");
const status = element<HTMLElement>("status-message");
const previousButton = element<HTMLButtonElement>("previous-page");
const nextButton = element<HTMLButtonElement>("next-page");
const pagePosition = element<HTMLElement>("page-position");
const dialog = element<HTMLDialogElement>("edit-dialog");
const editForm = element<HTMLFormElement>("edit-form");
const editTitle = element<HTMLElement>("edit-title");
const editSource = element<HTMLElement>("edit-source");
const editSourceLink = element<HTMLAnchorElement>("edit-source-link");
const editRawManufacturer = element<HTMLElement>("edit-raw-manufacturer");
const editRawModel = element<HTMLElement>("edit-raw-model");
const editRawCategory = element<HTMLElement>("edit-raw-category");
const editManufacturerId = element<HTMLInputElement>("edit-manufacturer-id");
const editModel = element<HTMLInputElement>("edit-model");
const editCategory = element<HTMLSelectElement>("edit-category");
const editChangeStatus = element<HTMLElement>("edit-change-status");
const closeEditButton = element<HTMLButtonElement>("close-edit");
const cancelEdit = element<HTMLButtonElement>("cancel-edit");
const saveEdit = element<HTMLButtonElement>("save-edit");

let categories: CategoryFacet[] = [];
let currentAfterId = 0;
let nextAfterId: number | null = null;
let history: number[] = [];
let currentItems: ListingProduct[] = [];
let editingId: number | null = null;
let editingSnapshot: EditSnapshot | null = null;
let busy = false;
let saving = false;

function message(value: string, kind: "info" | "error" | "success" = "info"): void {
  status.textContent = value;
  status.dataset.kind = kind;
}

function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  if (value === "listing_admin_manufacturer_not_verified") {
    return "指定したManufacturer IDは検証済みメーカーとして登録されていません。";
  }
  if (value === "listing_admin_category_invalid") {
    return "指定したカテゴリを登録商品へ設定できません。";
  }
  return value;
}

async function json<T>(response: Response): Promise<T> {
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // The HTTP status still provides a useful fallback error.
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

function hasActiveFilters(): boolean {
  return Boolean(
    queryInput.value.trim() ||
      shopKeyInput.value.trim() ||
      categoryFilter.value ||
      scopeFilter.value !== "active",
  );
}

function editIsDirty(): boolean {
  if (!editingSnapshot) return false;
  return (
    editManufacturerId.value.trim().toLowerCase() !== editingSnapshot.manufacturerId ||
    editModel.value.trim() !== editingSnapshot.model ||
    editCategory.value !== editingSnapshot.primaryCategoryId
  );
}

function updateInteractionState(): void {
  previousButton.disabled = busy || history.length === 0;
  nextButton.disabled = busy || nextAfterId === null;
  searchSubmit.disabled = busy;
  resetSearch.disabled = busy || !hasActiveFilters();
  queryInput.disabled = busy;
  shopKeyInput.disabled = busy;
  categoryFilter.disabled = busy;
  scopeFilter.disabled = busy;
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

function dateText(value: string): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

function priceText(value: number | null): string {
  return value == null ? "価格不明" : `¥${value.toLocaleString("ja-JP")}`;
}

function stockText(value: string): string {
  if (value === "in_stock") return "在庫あり";
  if (value === "sold_out") return "売切";
  return "不明";
}

function appendText(parent: HTMLElement, tag: string, text: string, className = ""): HTMLElement {
  const child = document.createElement(tag);
  child.textContent = text;
  if (className) child.className = className;
  parent.appendChild(child);
  return child;
}

function cell(): HTMLTableCellElement {
  return document.createElement("td");
}

function stackCell(
  ...lines: Array<{ text: string; strong?: boolean; className?: string }>
): HTMLTableCellElement {
  const td = cell();
  const stack = document.createElement("div");
  stack.className = "listing-cell-stack";
  for (const line of lines) {
    appendText(stack, line.strong ? "strong" : "small", line.text, line.className || "");
  }
  td.appendChild(stack);
  return td;
}

function overrideLabels(product: ListingProduct): string[] {
  const labels: string[] = [];
  if (product.overrides.manufacturerId !== null) labels.push("メーカー");
  if (product.overrides.model !== null) labels.push("型番");
  if (product.overrides.primaryCategoryId !== null) labels.push("カテゴリ");
  return labels;
}

function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function renderRow(product: ListingProduct): HTMLTableRowElement {
  const tr = document.createElement("tr");

  tr.appendChild(
    stackCell(
      { text: `#${product.id}`, strong: true },
      { text: product.shopKey },
      { text: product.sourceId, className: "listing-muted" },
    ),
  );

  const productCell = cell();
  appendText(productCell, "span", product.title, "listing-title");
  if (!product.isActive) appendText(productCell, "small", "掲載終了", "listing-muted");
  tr.appendChild(productCell);

  tr.appendChild(
    stackCell(
      { text: product.manufacturer || "—", strong: true },
      { text: product.canonicalManufacturerId || product.manufacturerId || "ID未解決" },
      { text: product.rawManufacturer || "—", className: "raw-value" },
    ),
  );

  tr.appendChild(
    stackCell(
      { text: product.model || "—", strong: true },
      { text: product.normalizedModel || "normalized未解決" },
      { text: product.rawModel || "—", className: "raw-value" },
    ),
  );

  tr.appendChild(
    stackCell(
      { text: product.category || "—", strong: true },
      { text: product.primaryCategoryId || "未分類" },
      { text: product.rawCategory || "—", className: "raw-value" },
    ),
  );

  const priceCell = cell();
  const priceStack = document.createElement("div");
  priceStack.className = "listing-cell-stack";
  appendText(priceStack, "span", priceText(product.priceYen), "listing-price");
  const stock = appendText(
    priceStack,
    "span",
    stockText(product.stockStatus),
    "listing-status-badge",
  );
  stock.dataset.state = product.stockStatus;
  priceCell.appendChild(priceStack);
  tr.appendChild(priceCell);

  tr.appendChild(stackCell({ text: dateText(product.lastSeenAt), strong: true }));

  const overrideCell = cell();
  const labels = overrideLabels(product);
  const badge = appendText(
    overrideCell,
    "span",
    labels.length ? labels.join(" / ") : "なし",
    "override-badge",
  );
  badge.dataset.active = labels.length ? "true" : "false";
  if (product.overrides.updatedAt) badge.title = `最終補正: ${dateText(product.overrides.updatedAt)}`;
  tr.appendChild(overrideCell);

  const actionCell = cell();
  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.className = "secondary-button";
  editButton.textContent = "編集";
  editButton.addEventListener("click", () => openEdit(product));
  actionCell.appendChild(editButton);
  tr.appendChild(actionCell);

  return tr;
}

function render(items: ListingProduct[]): void {
  rows.replaceChildren(...items.map(renderRow));
  emptyState.hidden = items.length !== 0;
  resultSummary.textContent = items.length
    ? `${items.length.toLocaleString("ja-JP")}件を表示`
    : "該当 0件";
  pagePosition.textContent = `ページ ${history.length + 1}`;
}

function populateCategories(): void {
  categoryFilter.replaceChildren();
  const all = document.createElement("option");
  all.value = "";
  all.textContent = "すべてのカテゴリ";
  categoryFilter.appendChild(all);

  editCategory.replaceChildren();
  for (const category of categories) {
    if (category.filterable) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      categoryFilter.appendChild(option);
    }
    if (category.classifiable) {
      const option = document.createElement("option");
      option.value = category.id;
      option.textContent = category.name;
      editCategory.appendChild(option);
    }
  }
}

function listUrl(): string {
  const params = new URLSearchParams();
  if (queryInput.value.trim()) params.set("q", queryInput.value.trim());
  if (shopKeyInput.value.trim()) params.set("shopKey", shopKeyInput.value.trim().toLowerCase());
  if (categoryFilter.value) params.set("categoryId", categoryFilter.value);
  params.set("scope", scopeFilter.value);
  if (currentAfterId) params.set("afterId", String(currentAfterId));
  params.set("limit", "50");
  return `/api/admin/listings?${params.toString()}`;
}

async function loadListings(): Promise<void> {
  setBusy(true);
  message("登録商品を読み込んでいます…");
  try {
    const response = await adminJson<ListingListResponse>(listUrl());
    currentItems = response.items;
    nextAfterId = response.nextAfterId;
    render(currentItems);
    message(
      hasActiveFilters() ? "検索条件を反映しました。" : "登録商品を表示しています。",
      "success",
    );
  } catch (error) {
    currentItems = [];
    nextAfterId = null;
    render([]);
    message(`登録商品の取得に失敗しました: ${errorText(error)}`, "error");
  } finally {
    setBusy(false);
  }
}

function closeEdit(force = false): void {
  if (!force && editIsDirty() && !window.confirm("未保存の変更を破棄しますか？")) return;
  editingId = null;
  editingSnapshot = null;
  dialog.close();
  updateInteractionState();
}

function openEdit(product: ListingProduct): void {
  editingId = product.id;
  editingSnapshot = {
    manufacturerId: product.canonicalManufacturerId || product.manufacturerId || "",
    model: product.model || "",
    primaryCategoryId: product.primaryCategoryId || "other",
  };
  editTitle.textContent = product.title;
  editSource.textContent = `${product.shopKey} / ${product.sourceId} / listing #${product.id}`;
  editRawManufacturer.textContent = product.rawManufacturer || "—";
  editRawModel.textContent = product.rawModel || "—";
  editRawCategory.textContent = product.rawCategory || "—";
  editManufacturerId.value = editingSnapshot.manufacturerId;
  editModel.value = editingSnapshot.model;
  editCategory.value = editingSnapshot.primaryCategoryId;

  const sourceUrl = safeSourceUrl(product.sourceUrl);
  editSourceLink.hidden = !sourceUrl;
  if (sourceUrl) editSourceLink.href = sourceUrl;
  else editSourceLink.removeAttribute("href");

  updateInteractionState();
  dialog.showModal();
}

async function saveEditing(): Promise<void> {
  if (editingId === null || !editingSnapshot || saving || !editIsDirty()) return;
  const input: { manufacturerId?: string; model?: string; primaryCategoryId?: string } = {};
  const manufacturerId = editManufacturerId.value.trim().toLowerCase();
  const model = editModel.value.trim();
  const primaryCategoryId = editCategory.value;
  if (manufacturerId !== editingSnapshot.manufacturerId) input.manufacturerId = manufacturerId;
  if (model !== editingSnapshot.model) input.model = model;
  if (primaryCategoryId !== editingSnapshot.primaryCategoryId) {
    input.primaryCategoryId = primaryCategoryId;
  }

  saving = true;
  updateInteractionState();
  try {
    const response = await adminJson<ListingUpdateResponse>(`/api/admin/listings/${editingId}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    });
    closeEdit(true);
    message(
      `listing #${response.listing.id} を保存し、検索・Product Identityを再投影しました。`,
      "success",
    );
    await loadListings();
  } catch (error) {
    message(`保存に失敗しました: ${errorText(error)}`, "error");
  } finally {
    saving = false;
    updateInteractionState();
  }
}

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  currentAfterId = 0;
  nextAfterId = null;
  history = [];
  void loadListings();
});

resetSearch.addEventListener("click", () => {
  queryInput.value = "";
  shopKeyInput.value = "";
  categoryFilter.value = "";
  scopeFilter.value = "active";
  currentAfterId = 0;
  nextAfterId = null;
  history = [];
  void loadListings();
});

nextButton.addEventListener("click", () => {
  if (nextAfterId === null || busy) return;
  history.push(currentAfterId);
  currentAfterId = nextAfterId;
  void loadListings();
});

previousButton.addEventListener("click", () => {
  if (!history.length || busy) return;
  currentAfterId = history.pop() || 0;
  void loadListings();
});

for (const input of [queryInput, shopKeyInput, categoryFilter, scopeFilter]) {
  input.addEventListener("input", updateInteractionState);
  input.addEventListener("change", updateInteractionState);
}
for (const input of [editManufacturerId, editModel, editCategory]) {
  input.addEventListener("input", updateInteractionState);
  input.addEventListener("change", updateInteractionState);
}

closeEditButton.addEventListener("click", () => closeEdit());
cancelEdit.addEventListener("click", () => closeEdit());
dialog.addEventListener("cancel", (event) => {
  if (!editIsDirty()) return;
  event.preventDefault();
  closeEdit();
});
editForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void saveEditing();
});

async function initialize(): Promise<void> {
  message("管理データを読み込んでいます…");
  try {
    const meta = await adminJson<MetaResponse>("/api/meta");
    categories = meta.categoryFacets;
    populateCategories();
    controls.hidden = false;
    await loadListings();
  } catch (error) {
    message(`管理画面の初期化に失敗しました: ${errorText(error)}`, "error");
  }
}

void initialize();
