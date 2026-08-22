export {};

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

let categories: CategoryFacet[] = [];
let currentAfterId = 0;
let nextAfterId: number | null = null;
let history: number[] = [];
let editingId: number | null = null;
let busy = false;

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

async function start(): Promise<void> {
  try {
    await loadCategories();
    await load(0, true);
  } catch (error) {
    message(`管理画面を初期化できません: ${errorText(error)}`, "error");
  }
}

void start();
