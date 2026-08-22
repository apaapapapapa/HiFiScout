export {};

type LifecycleStatus = "unknown" | "active" | "discontinued";

interface CategoryFacet {
  id: string;
  name: string;
  classifiable: boolean;
  filterable: boolean;
}

interface CatalogCandidate {
  id: number;
  manufacturerId: string;
  normalizedModel: string;
  observedManufacturer: string;
  observedModel: string;
  sampleTitle: string;
  candidateCategoryIds: string[];
  activeListingCount: number;
  shopCount: number;
  unclassifiedCount: number;
  priorityScore: number;
  verificationStatus: string;
  lastVerificationAt: string | null;
  verificationMessage: string;
  sourceUrl: string;
  updatedAt: string;
}

interface CandidateListResponse {
  items: CatalogCandidate[];
  nextAfterId: number | null;
  hasMore: boolean;
}

interface ManualWriteResponse {
  product: { id: number };
  created: boolean;
  matchedExisting: boolean;
  refreshedListings: number;
  replayedListings: number;
  newlyMatchedListings: number;
  replayComplete: boolean;
}

interface MergeResponse {
  targetProductId: number;
  removedProductId: number;
  movedMatchedListings: number;
  refreshedListings: number;
  replayedListings: number;
  replayComplete: boolean;
}

interface ApiErrorBody {
  error?: unknown;
  existingProductId?: unknown;
}

class AdminOperationError extends Error {
  readonly existingProductId: number | null;

  constructor(code: string, body: ApiErrorBody | null) {
    super(code);
    const id = Number(body?.existingProductId || 0);
    this.existingProductId = Number.isSafeInteger(id) && id > 0 ? id : null;
  }
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing #${id}`);
  return value as T;
}

const status = element<HTMLElement>("status-message");
const catalogSearchForm = element<HTMLFormElement>("catalog-search-form");
const openCreateButton = element<HTMLButtonElement>("open-create");

const candidateForm = element<HTMLFormElement>("candidate-search-form");
const candidateQuery = element<HTMLInputElement>("candidate-query");
const candidateManufacturer = element<HTMLInputElement>("candidate-manufacturer-id");
const candidateCategory = element<HTMLSelectElement>("candidate-category-filter");
const candidateReset = element<HTMLButtonElement>("candidate-reset-search");
const candidateRows = element<HTMLTableSectionElement>("candidate-rows");
const candidateSummary = element<HTMLElement>("candidate-result-summary");
const candidateEmpty = element<HTMLElement>("candidate-empty-state");
const candidatePrevious = element<HTMLButtonElement>("candidate-previous-page");
const candidateNext = element<HTMLButtonElement>("candidate-next-page");
const candidatePage = element<HTMLElement>("candidate-page-position");

const createDialog = element<HTMLDialogElement>("create-dialog");
const createForm = element<HTMLFormElement>("create-form");
const createDialogTitle = element<HTMLElement>("create-dialog-title");
const createContext = element<HTMLElement>("create-context");
const createCandidateIdentity = element<HTMLElement>("create-candidate-identity");
const createCandidateSample = element<HTMLElement>("create-candidate-sample");
const createManufacturer = element<HTMLInputElement>("create-manufacturer");
const createModel = element<HTMLInputElement>("create-model");
const createName = element<HTMLInputElement>("create-name");
const createCategory = element<HTMLSelectElement>("create-category");
const createLifecycle = element<HTMLSelectElement>("create-lifecycle");
const createSourceUrl = element<HTMLInputElement>("create-source-url");
const closeCreate = element<HTMLButtonElement>("close-create");
const cancelCreate = element<HTMLButtonElement>("cancel-create");
const createSubmit = element<HTMLButtonElement>("create-submit");

const editDialog = element<HTMLDialogElement>("edit-dialog");
const editIdentity = element<HTMLElement>("edit-identity");
const mergeSourceId = element<HTMLInputElement>("merge-source-id");
const mergeStatus = element<HTMLElement>("merge-status");
const mergeSubmit = element<HTMLButtonElement>("merge-submit");

let categories: CategoryFacet[] = [];
let verifyingCandidateId: number | null = null;
let candidateAfterId = 0;
let candidateNextAfterId: number | null = null;
let candidateHistory: number[] = [];
let candidateBusy = false;
let operationBusy = false;

function showMessage(value: string, kind: "info" | "error" | "success" = "info"): void {
  status.textContent = value;
  status.dataset.kind = kind;
}

function operationErrorText(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error);
  if (code === "catalog_admin_product_already_exists") {
    const id = error instanceof AdminOperationError ? error.existingProductId : null;
    return id
      ? `同じメーカー・型番のCatalog #${id} がすでに存在します。`
      : "同じメーカー・型番のCatalogがすでに存在します。";
  }
  if (code === "catalog_admin_merge_manufacturer_mismatch") {
    return "メーカーが異なるCatalog同士は統合できません。";
  }
  if (code === "catalog_admin_merge_same_product") return "同じCatalog IDは統合できません。";
  if (code === "catalog_admin_category_invalid") return "主カテゴリが不正です。";
  if (code === "catalog_admin_model_invalid") return "型番が不正です。";
  if (code === "not_found") return "対象が見つかりません。再読み込みしてください。";
  return code;
}

async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // HTTP status is enough for the fallback error.
  }
  if (!response.ok) {
    const parsed = body && typeof body === "object" ? (body as ApiErrorBody) : null;
    const code = typeof parsed?.error === "string" ? parsed.error : `HTTP ${response.status}`;
    throw new AdminOperationError(code, parsed);
  }
  return body as T;
}

function categoryName(id: string): string {
  return categories.find((category) => category.id === id)?.name.trim() || id || "—";
}

function candidatePrimaryCategory(candidate: CatalogCandidate): string {
  return (
    candidate.candidateCategoryIds.find((id) =>
      categories.some((category) => category.id === id && category.classifiable),
    ) || ""
  );
}

function candidateStatus(value: string): string {
  if (value === "not_found") return "未発見";
  if (value === "ambiguous") return "曖昧";
  if (value === "unsupported") return "未対応";
  if (value === "error") return "エラー";
  return "未検証";
}

function tableCell(row: HTMLTableRowElement, label: string, value: string, className = ""): void {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  cell.textContent = value;
  if (className) cell.className = className;
  row.appendChild(cell);
}

function badgeCell(row: HTMLTableRowElement, label: string, value: string, className: string): void {
  const cell = document.createElement("td");
  cell.dataset.label = label;
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = value;
  badge.title = value;
  cell.appendChild(badge);
  row.appendChild(cell);
}

function updateCandidateControls(): void {
  candidateQuery.disabled = candidateBusy || operationBusy;
  candidateManufacturer.disabled = candidateBusy || operationBusy;
  candidateCategory.disabled = candidateBusy || operationBusy;
  candidateReset.disabled =
    candidateBusy ||
    operationBusy ||
    !(candidateQuery.value.trim() || candidateManufacturer.value.trim() || candidateCategory.value);
  candidatePrevious.disabled = candidateBusy || operationBusy || candidateHistory.length === 0;
  candidateNext.disabled = candidateBusy || operationBusy || candidateNextAfterId === null;
  openCreateButton.disabled = operationBusy;
  createSubmit.disabled = operationBusy;
  createSubmit.textContent = operationBusy
    ? "処理中…"
    : verifyingCandidateId === null
      ? "検証済みとして登録"
      : "候補を手動Verify";
  updateMergeButton();
}

function candidateParams(afterId: number): URLSearchParams {
  const params = new URLSearchParams({ limit: "50" });
  if (candidateQuery.value.trim()) params.set("q", candidateQuery.value.trim());
  if (candidateManufacturer.value.trim()) {
    params.set("manufacturerId", candidateManufacturer.value.trim().toLowerCase());
  }
  if (candidateCategory.value) params.set("categoryId", candidateCategory.value);
  if (afterId) params.set("afterId", String(afterId));
  return params;
}

function renderCandidates(items: CatalogCandidate[]): void {
  candidateRows.replaceChildren();
  candidateEmpty.hidden = items.length !== 0;
  for (const candidate of items) {
    const manufacturer = candidate.observedManufacturer || candidate.manufacturerId;
    const model = candidate.observedModel || candidate.normalizedModel;
    const row = document.createElement("tr");
    tableCell(row, "ID", String(candidate.id), "id-cell");
    tableCell(row, "メーカー", manufacturer);
    tableCell(row, "型番", model, "model-cell");
    tableCell(row, "サンプル", candidate.sampleTitle || `${manufacturer} ${model}`.trim(), "name-cell");
    badgeCell(row, "カテゴリ", categoryName(candidatePrimaryCategory(candidate)), "category-badge");
    badgeCell(
      row,
      "状態",
      candidateStatus(candidate.verificationStatus),
      "lifecycle-badge lifecycle-unknown",
    );
    badgeCell(row, "listing", String(candidate.activeListingCount), "count-badge");
    tableCell(
      row,
      "更新日時",
      candidate.updatedAt ? new Date(candidate.updatedAt).toLocaleString("ja-JP") : "—",
      "updated-cell",
    );
    const action = document.createElement("td");
    action.dataset.label = "操作";
    action.className = "row-actions";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "secondary-button compact";
    button.textContent = "手動Verify";
    button.addEventListener("click", () => openManualDialog(candidate));
    action.appendChild(button);
    row.appendChild(action);
    candidateRows.appendChild(row);
  }
}

function candidateSummaryText(count: number): string {
  const filters: string[] = [];
  if (candidateQuery.value.trim()) filters.push(`検索「${candidateQuery.value.trim()}」`);
  if (candidateManufacturer.value.trim()) filters.push(`メーカー ${candidateManufacturer.value.trim()}`);
  if (candidateCategory.value) filters.push(categoryName(candidateCategory.value));
  return filters.length ? `${count}件表示 · ${filters.join(" · ")}` : `${count}件表示 · 未検証候補`;
}

async function loadCandidates(
  afterId = 0,
  resetHistory = false,
  nextHistory: number[] | null = null,
): Promise<void> {
  if (candidateBusy || operationBusy) return;
  candidateBusy = true;
  updateCandidateControls();
  try {
    const result = await adminJson<CandidateListResponse>(
      `/api/admin/knowledge-catalog/candidates?${candidateParams(afterId)}`,
    );
    candidateAfterId = afterId;
    candidateNextAfterId = result.nextAfterId;
    if (resetHistory) candidateHistory = [];
    else if (nextHistory) candidateHistory = nextHistory;
    renderCandidates(result.items);
    candidateSummary.textContent = candidateSummaryText(result.items.length);
    candidatePage.textContent = `ページ ${candidateHistory.length + 1}`;
  } catch (error) {
    showMessage(`未検証候補を読み込めません: ${operationErrorText(error)}`, "error");
  } finally {
    candidateBusy = false;
    updateCandidateControls();
  }
}

function clearCandidateFilters(): void {
  candidateQuery.value = "";
  candidateManufacturer.value = "";
  candidateCategory.value = "";
  void loadCandidates(0, true);
}

function openManualDialog(candidate: CatalogCandidate | null = null): void {
  verifyingCandidateId = candidate?.id ?? null;
  createDialogTitle.textContent = candidate ? "未検証候補を手動Verify" : "Catalogを手動追加";
  createContext.hidden = !candidate;
  const manufacturer = candidate?.observedManufacturer || candidate?.manufacturerId || "";
  const model = candidate?.observedModel || candidate?.normalizedModel || "";
  createCandidateIdentity.textContent = candidate
    ? `${manufacturer} / ${model} (#${candidate.id})`
    : "";
  createCandidateSample.textContent = candidate?.sampleTitle || "";
  createManufacturer.value = candidate?.manufacturerId || "";
  createModel.value = model;
  createName.value = candidate ? `${manufacturer} ${model}`.trim() : "";
  createCategory.value = candidate ? candidatePrimaryCategory(candidate) : "";
  createLifecycle.value = "unknown" satisfies LifecycleStatus;
  createSourceUrl.value = candidate?.sourceUrl || "";
  createDialog.showModal();
  updateCandidateControls();
  requestAnimationFrame(() => (candidate ? createName : createManufacturer).focus());
}

function manualPayload(): object | null {
  const manufacturerId = createManufacturer.value.trim();
  const canonicalModel = createModel.value.trim();
  const canonicalName = createName.value.trim();
  const primaryCategoryId = createCategory.value;
  if (!manufacturerId || !canonicalModel || !canonicalName || !primaryCategoryId) return null;
  return {
    manufacturerId,
    canonicalModel,
    canonicalName,
    primaryCategoryId,
    lifecycleStatus: createLifecycle.value,
    sourceUrl: createSourceUrl.value.trim(),
  };
}

async function submitManualCatalog(): Promise<void> {
  if (operationBusy) return;
  const payload = manualPayload();
  if (!payload) {
    showMessage("メーカー、型番、表示名、カテゴリは必須です。", "error");
    return;
  }
  operationBusy = true;
  updateCandidateControls();
  const candidateId = verifyingCandidateId;
  try {
    const endpoint =
      candidateId === null
        ? "/api/admin/knowledge-catalog/products"
        : `/api/admin/knowledge-catalog/candidates/${candidateId}/verify`;
    const result = await adminJson<ManualWriteResponse>(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    });
    createDialog.close();
    if (candidateId !== null) await loadCandidates(candidateAfterId);
    else catalogSearchForm.requestSubmit();
    const resultText = result.matchedExisting
      ? `既存Catalog #${result.product.id} に候補を紐付けました。`
      : result.created
        ? `Catalog #${result.product.id} を手動追加しました。`
        : `Catalog #${result.product.id} を手動Verifyしました。`;
    const replayText = result.replayComplete
      ? `${result.replayedListings}件を再評価し、${result.newlyMatchedListings}件が一致しました。`
      : `${result.replayedListings}件を再評価し、残りは通常のremediationで継続します。`;
    showMessage(`${resultText} ${replayText}`, "success");
  } catch (error) {
    showMessage(`手動登録できません: ${operationErrorText(error)}`, "error");
  } finally {
    operationBusy = false;
    updateCandidateControls();
  }
}

function targetCatalogId(): number | null {
  const match = editIdentity.textContent?.match(/\(#(\d+)\)\s*$/u);
  const id = Number(match?.[1] || 0);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function updateMergeButton(): void {
  const targetId = targetCatalogId();
  const sourceId = Number(mergeSourceId.value);
  mergeSubmit.disabled =
    operationBusy ||
    targetId === null ||
    !Number.isSafeInteger(sourceId) ||
    sourceId <= 0 ||
    sourceId === targetId;
  mergeSubmit.textContent = operationBusy ? "処理中…" : "このCatalogへ統合";
}

async function mergeCatalog(): Promise<void> {
  if (operationBusy) return;
  const targetId = targetCatalogId();
  const sourceId = Number(mergeSourceId.value);
  if (
    targetId === null ||
    !Number.isSafeInteger(sourceId) ||
    sourceId <= 0 ||
    sourceId === targetId
  ) {
    mergeStatus.textContent = "統合元には、現在のCatalogとは異なる有効なIDを入力してください。";
    mergeStatus.dataset.dirty = "warning";
    return;
  }
  if (
    !window.confirm(
      `Catalog #${sourceId} を Catalog #${targetId} へ統合します。\n\n#${targetId} を残し、#${sourceId} は削除されます。alias・source・検証履歴・Product Identityは残す側へ移します。続行しますか？`,
    )
  ) {
    return;
  }

  operationBusy = true;
  mergeStatus.textContent = "統合しています…";
  mergeStatus.dataset.dirty = "true";
  updateCandidateControls();
  try {
    const result = await adminJson<MergeResponse>(
      `/api/admin/knowledge-catalog/products/${targetId}/merge`,
      { method: "POST", body: JSON.stringify({ sourceProductId: sourceId }) },
    );
    editDialog.close();
    catalogSearchForm.requestSubmit();
    const replayText = result.replayComplete
      ? "再投影も完了しました。"
      : "残りの再投影は通常のremediationで継続します。";
    showMessage(
      `Catalog #${result.removedProductId} を #${result.targetProductId} に統合しました。${result.movedMatchedListings}件の一致済みlistingを移行し、${result.replayedListings}件を再評価しました。${replayText}`,
      "success",
    );
  } catch (error) {
    mergeStatus.textContent = `統合できません: ${operationErrorText(error)}`;
    mergeStatus.dataset.dirty = "warning";
    showMessage(`Catalogを統合できません: ${operationErrorText(error)}`, "error");
  } finally {
    operationBusy = false;
    updateCandidateControls();
  }
}

async function loadCategories(): Promise<void> {
  const result = await adminJson<{ categoryFacets: CategoryFacet[] }>("/api/meta");
  categories = result.categoryFacets;
  candidateCategory.replaceChildren(new Option("すべてのカテゴリ", ""));
  createCategory.replaceChildren(new Option("カテゴリを選択", ""));
  for (const category of categories) {
    if (category.filterable) candidateCategory.add(new Option(category.name, category.id));
    if (category.classifiable) createCategory.add(new Option(category.name, category.id));
  }
}

candidateForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void loadCandidates(0, true);
});
candidateReset.addEventListener("click", clearCandidateFilters);
candidatePrevious.addEventListener("click", () => {
  const previous = candidateHistory.at(-1);
  if (previous !== undefined) {
    void loadCandidates(previous, false, candidateHistory.slice(0, -1));
  }
});
candidateNext.addEventListener("click", () => {
  if (candidateNextAfterId !== null) {
    void loadCandidates(candidateNextAfterId, false, [...candidateHistory, candidateAfterId]);
  }
});
for (const control of [candidateQuery, candidateManufacturer, candidateCategory]) {
  control.addEventListener("input", updateCandidateControls);
  control.addEventListener("change", updateCandidateControls);
}

openCreateButton.addEventListener("click", () => openManualDialog());
closeCreate.addEventListener("click", () => createDialog.close());
cancelCreate.addEventListener("click", () => createDialog.close());
createDialog.addEventListener("close", () => {
  verifyingCandidateId = null;
  updateCandidateControls();
});
createForm.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitManualCatalog();
});

mergeSourceId.addEventListener("input", updateMergeButton);
mergeSubmit.addEventListener("click", () => void mergeCatalog());
editDialog.addEventListener("close", () => {
  mergeSourceId.value = "";
  mergeStatus.textContent = "";
  updateMergeButton();
});

async function start(): Promise<void> {
  try {
    await loadCategories();
    updateCandidateControls();
    await loadCandidates(0, true);
  } catch (error) {
    showMessage(`手動Catalog操作を初期化できません: ${operationErrorText(error)}`, "error");
  }
}

void start();
