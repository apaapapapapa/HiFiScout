import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";

import {
  AdminOperationError,
  EMPTY_STATUS,
  adminJson,
  dateText,
  genericErrorText,
} from "./admin-shared.js";
import type { CategoryFacet, StatusMessage } from "./admin-shared.js";

type LifecycleStatus = "unknown" | "active" | "discontinued";

interface CatalogProduct {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  canonicalName: string;
  lifecycleStatus: LifecycleStatus;
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

interface DuplicateProduct {
  id: number;
  manufacturerId: string;
  canonicalModel: string;
  canonicalName: string;
  lifecycleStatus: LifecycleStatus;
  primaryCategoryId: string;
  matchedListingCount: number;
  aliasCount: number;
  sourceCount: number;
  updatedAt: string;
}

interface DuplicateGroup {
  groupKey: string;
  manufacturerId: string;
  identityModel: string;
  suggestedTargetId: number;
  products: DuplicateProduct[];
}

interface DuplicateListResponse {
  items: DuplicateGroup[];
  nextAfterKey: string | null;
  hasMore: boolean;
}

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

interface CsvExportLatestResponse {
  job: CsvExportJob | null;
}

interface CsvExportConfig {
  title: string;
  kicker: string;
  description: string;
  collectionUrl: string;
  latestUrl: string;
  startBody: object;
  downloadUrl(jobId: string): string;
  secondary?: boolean;
  muted?: boolean;
}

const CSV_EXPORT_CONFIG: Record<CsvExportKey, CsvExportConfig> = {
  catalog: {
    title: "Knowledge Catalog",
    kicker: "CATALOG",
    description:
      "検証状態を含むカタログ全件を100件ずつ低負荷で処理します。上限90,000件・生成期限24時間です。",
    collectionUrl: "/api/admin/knowledge-catalog-exports",
    latestUrl: "/api/admin/knowledge-catalog-exports",
    startBody: {},
    downloadUrl: (jobId) =>
      `/api/admin/knowledge-catalog-exports/${encodeURIComponent(jobId)}/download`,
  },
  "product-audit-active": {
    title: "掲載中商品",
    kicker: "RECOMMENDED",
    description: "現在掲載中のlistingを品質監査用CSVとして生成します。",
    collectionUrl: "/api/admin/product-audit-exports",
    latestUrl: "/api/admin/product-audit-exports?scope=active",
    startBody: { scope: "active" },
    downloadUrl: (jobId) =>
      `/api/admin/product-audit-exports/${encodeURIComponent(jobId)}/download`,
  },
  "product-audit-all": {
    title: "全履歴",
    kicker: "ARCHIVE",
    description: "販売終了・非掲載を含む全listing履歴を監査用CSVとして生成します。",
    collectionUrl: "/api/admin/product-audit-exports",
    latestUrl: "/api/admin/product-audit-exports?scope=all",
    startBody: { scope: "all" },
    downloadUrl: (jobId) =>
      `/api/admin/product-audit-exports/${encodeURIComponent(jobId)}/download`,
    secondary: true,
    muted: true,
  },
};

interface CsvExportState {
  job: CsvExportJob | null;
  busy: boolean;
  error: string;
}

type CsvExportStates = Record<CsvExportKey, CsvExportState>;

const INITIAL_CSV_STATES: CsvExportStates = {
  catalog: { job: null, busy: true, error: "" },
  "product-audit-active": { job: null, busy: true, error: "" },
  "product-audit-all": { job: null, busy: true, error: "" },
};

interface CatalogFilters {
  q: string;
  manufacturerId: string;
  categoryId: string;
}

const EMPTY_FILTERS: CatalogFilters = { q: "", manufacturerId: "", categoryId: "" };

interface CreateDraft {
  manufacturerId: string;
  canonicalModel: string;
  canonicalName: string;
  primaryCategoryId: string;
  lifecycleStatus: LifecycleStatus;
  sourceUrl: string;
}

const EMPTY_CREATE_DRAFT: CreateDraft = {
  manufacturerId: "",
  canonicalModel: "",
  canonicalName: "",
  primaryCategoryId: "",
  lifecycleStatus: "unknown",
  sourceUrl: "",
};

function catalogErrorText(error: unknown): string {
  const code = genericErrorText(error);
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

function lifecycleName(value: LifecycleStatus): string {
  return value === "active" ? "現行" : value === "discontinued" ? "生産完了" : "不明";
}

function lifecycleClass(value: LifecycleStatus): string {
  return value === "active"
    ? "lifecycle-active"
    : value === "discontinued"
      ? "lifecycle-discontinued"
      : "lifecycle-unknown";
}

function candidateStatus(value: string): string {
  if (value === "not_found") return "未発見";
  if (value === "ambiguous") return "曖昧";
  if (value === "unsupported") return "未対応";
  if (value === "error") return "エラー";
  return "未検証";
}

function csvExportDate(value: string | null): string {
  return value ? dateText(value) : "—";
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
  if (error === "knowledge_catalog_export_too_large") return "90,000件の上限を超えました。";
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

function CsvExportCard({
  config,
  state,
  onGenerate,
}: {
  config: CsvExportConfig;
  state: CsvExportState;
  onGenerate: () => void;
}) {
  const job = state.job;
  const active = csvExportActive(job);
  const expired = job ? csvExportExpired(job) : false;
  let statusText = "まだ生成されていません。";
  let statusKind = "info";
  if (state.error) {
    statusText = state.error;
    statusKind = "error";
  } else if (job?.status === "queued") {
    statusText = job.rowCount
      ? `${job.rowCount.toLocaleString("ja-JP")}件を生成済みです。次のバッチを待っています…`
      : `生成待ちです（受付: ${csvExportDate(job.createdAt)}）。`;
  } else if (job?.status === "processing") {
    statusText = `${job.rowCount.toLocaleString("ja-JP")}件を生成済みです。負荷を抑えながら処理しています…`;
  } else if (job?.status === "failed") {
    statusText = job.error
      ? `生成に失敗しました: ${csvExportFailureMessage(job.error)}`
      : "生成に失敗しました。もう一度お試しください。";
    statusKind = "error";
  } else if (job && expired) {
    statusText = "ダウンロード期限が切れました。もう一度生成してください。";
    statusKind = "error";
  } else if (job?.status === "ready") {
    statusText = `${job.rowCount.toLocaleString("ja-JP")}件（${csvExportBytes(job.byteCount)}）の生成が完了しました。有効期限: ${csvExportDate(job.expiresAt)}`;
    statusKind = "success";
  }
  const buttonText = state.busy ? "受付中…" : active ? "生成中…" : job ? "再生成" : "CSVを生成";
  return (
    <section className="export-job">
      <div>
        <span className={`job-kicker${config.muted ? " job-kicker-muted" : ""}`}>
          {config.kicker}
        </span>
        <h3>{config.title}</h3>
        <p className="export-job-description">{config.description}</p>
        <p className="export-status" role="status" aria-live="polite" data-kind={statusKind}>
          {statusText}
        </p>
      </div>
      <div className="export-job-actions">
        <button
          className={config.secondary ? "secondary-button" : undefined}
          type="button"
          disabled={state.busy || active}
          onClick={onGenerate}
        >
          {buttonText}
        </button>
        {job?.status === "ready" && !expired ? (
          <a className="button-link secondary-button" href={config.downloadUrl(job.id)}>
            ダウンロード
          </a>
        ) : null}
      </div>
    </section>
  );
}

export function CatalogAdmin() {
  const [status, setStatus] = useState<StatusMessage>(EMPTY_STATUS);
  const [categories, setCategories] = useState<CategoryFacet[]>([]);
  const categoryNames = useMemo(
    () => new Map(categories.map((category) => [category.id, category.name.trim()])),
    [categories],
  );
  const categoryName = useCallback(
    (id: string) => categoryNames.get(id) || id || "—",
    [categoryNames],
  );

  const [catalogDraft, setCatalogDraft] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [catalogApplied, setCatalogApplied] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [catalogItems, setCatalogItems] = useState<CatalogProduct[]>([]);
  const [catalogAfterId, setCatalogAfterId] = useState(0);
  const [catalogNextAfterId, setCatalogNextAfterId] = useState<number | null>(null);
  const [catalogHistory, setCatalogHistory] = useState<number[]>([]);
  const [catalogBusy, setCatalogBusy] = useState(true);
  const [catalogReady, setCatalogReady] = useState(false);

  const [candidateDraft, setCandidateDraft] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [candidateApplied, setCandidateApplied] = useState<CatalogFilters>(EMPTY_FILTERS);
  const [candidateItems, setCandidateItems] = useState<CatalogCandidate[]>([]);
  const [candidateAfterId, setCandidateAfterId] = useState(0);
  const [candidateNextAfterId, setCandidateNextAfterId] = useState<number | null>(null);
  const [candidateHistory, setCandidateHistory] = useState<number[]>([]);
  const [candidateBusy, setCandidateBusy] = useState(true);

  const [duplicateManufacturerDraft, setDuplicateManufacturerDraft] = useState("");
  const [duplicateManufacturerApplied, setDuplicateManufacturerApplied] = useState("");
  const [duplicateItems, setDuplicateItems] = useState<DuplicateGroup[]>([]);
  const [duplicateAfterKey, setDuplicateAfterKey] = useState("");
  const [duplicateNextAfterKey, setDuplicateNextAfterKey] = useState<string | null>(null);
  const [duplicateHistory, setDuplicateHistory] = useState<string[]>([]);
  const [duplicateBusy, setDuplicateBusy] = useState(true);
  /** Survivor chosen per group; a group falls back to the server's suggestion until touched. */
  const [duplicateTargets, setDuplicateTargets] = useState<Record<string, number>>({});
  const [mergingGroupKey, setMergingGroupKey] = useState("");

  const [editing, setEditing] = useState<CatalogProduct | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editLifecycle, setEditLifecycle] = useState<LifecycleStatus>("unknown");
  const [editSaving, setEditSaving] = useState(false);
  const [editWarning, setEditWarning] = useState(false);
  const [mergeSourceId, setMergeSourceId] = useState("");
  const [mergeStatus, setMergeStatus] = useState("");
  const editDialogRef = useRef<HTMLDialogElement>(null);

  const [createMode, setCreateMode] = useState<{ candidate: CatalogCandidate | null } | null>(null);
  const [createDraft, setCreateDraft] = useState<CreateDraft>(EMPTY_CREATE_DRAFT);
  const [operationBusy, setOperationBusy] = useState(false);
  const createDialogRef = useRef<HTMLDialogElement>(null);

  const [csvStates, setCsvStates] = useState<CsvExportStates>(INITIAL_CSV_STATES);

  const loadCatalog = useCallback(
    async (filters: CatalogFilters, afterId: number, nextHistory: number[]) => {
      setCatalogBusy(true);
      setStatus({ text: "Catalogを読み込んでいます…", kind: "info" });
      const params = new URLSearchParams({ limit: "50" });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.manufacturerId.trim()) {
        params.set("manufacturerId", filters.manufacturerId.trim().toLowerCase());
      }
      if (filters.categoryId) params.set("categoryId", filters.categoryId);
      if (afterId) params.set("afterId", String(afterId));
      try {
        const result = await adminJson<CatalogListResponse>(
          `/api/admin/knowledge-catalog/products?${params}`,
        );
        setCatalogItems(result.items);
        setCatalogAfterId(afterId);
        setCatalogNextAfterId(result.nextAfterId);
        setCatalogHistory(nextHistory);
        setCatalogReady(true);
        setStatus(EMPTY_STATUS);
      } catch (error) {
        setStatus({ text: `Catalogを読み込めません: ${catalogErrorText(error)}`, kind: "error" });
      } finally {
        setCatalogBusy(false);
      }
    },
    [],
  );

  const loadCandidates = useCallback(
    async (filters: CatalogFilters, afterId: number, nextHistory: number[]) => {
      setCandidateBusy(true);
      const params = new URLSearchParams({ limit: "50" });
      if (filters.q.trim()) params.set("q", filters.q.trim());
      if (filters.manufacturerId.trim()) {
        params.set("manufacturerId", filters.manufacturerId.trim().toLowerCase());
      }
      if (filters.categoryId) params.set("categoryId", filters.categoryId);
      if (afterId) params.set("afterId", String(afterId));
      try {
        const result = await adminJson<CandidateListResponse>(
          `/api/admin/knowledge-catalog/candidates?${params}`,
        );
        setCandidateItems(result.items);
        setCandidateAfterId(afterId);
        setCandidateNextAfterId(result.nextAfterId);
        setCandidateHistory(nextHistory);
      } catch (error) {
        setStatus({
          text: `未検証候補を読み込めません: ${catalogErrorText(error)}`,
          kind: "error",
        });
      } finally {
        setCandidateBusy(false);
      }
    },
    [],
  );

  const loadDuplicates = useCallback(
    async (manufacturerId: string, afterKey: string, nextHistory: string[]) => {
      setDuplicateBusy(true);
      const params = new URLSearchParams({ limit: "20" });
      if (manufacturerId.trim()) params.set("manufacturerId", manufacturerId.trim().toLowerCase());
      if (afterKey) params.set("afterKey", afterKey);
      try {
        const result = await adminJson<DuplicateListResponse>(
          `/api/admin/knowledge-catalog/duplicates?${params}`,
        );
        setDuplicateItems(result.items);
        setDuplicateAfterKey(afterKey);
        setDuplicateNextAfterKey(result.nextAfterKey);
        setDuplicateHistory(nextHistory);
        // A reloaded page carries fresh suggestions, so stale choices must not survive it.
        setDuplicateTargets({});
      } catch (error) {
        setStatus({
          text: `重複Catalogを読み込めません: ${catalogErrorText(error)}`,
          kind: "error",
        });
      } finally {
        setDuplicateBusy(false);
      }
    },
    [],
  );

  const loadLatestCsvExport = useCallback(async (key: CsvExportKey, initial = false) => {
    try {
      const result = await adminJson<CsvExportLatestResponse>(CSV_EXPORT_CONFIG[key].latestUrl);
      setCsvStates((current) => ({
        ...current,
        [key]: { job: result.job, busy: false, error: "" },
      }));
    } catch (error) {
      setCsvStates((current) => ({
        ...current,
        [key]: {
          ...current[key],
          busy: initial ? false : current[key].busy,
          error: `CSVの生成状況を確認できません: ${genericErrorText(error)}`,
        },
      }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setStatus({ text: "管理データを読み込んでいます…", kind: "info" });
      try {
        const meta = await adminJson<{ categoryFacets: CategoryFacet[] }>("/api/meta");
        if (cancelled) return;
        setCategories(meta.categoryFacets);
        await Promise.all([
          loadCatalog(EMPTY_FILTERS, 0, []),
          loadCandidates(EMPTY_FILTERS, 0, []),
          loadDuplicates("", "", []),
          ...CSV_EXPORT_KEYS.map((key) => loadLatestCsvExport(key, true)),
        ]);
      } catch (error) {
        if (!cancelled) {
          setCatalogBusy(false);
          setCandidateBusy(false);
          setDuplicateBusy(false);
          setStatus({
            text: `管理画面を初期化できません: ${catalogErrorText(error)}`,
            kind: "error",
          });
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [loadCatalog, loadCandidates, loadDuplicates, loadLatestCsvExport]);

  useEffect(() => {
    const activeKeys = CSV_EXPORT_KEYS.filter((key) => csvExportActive(csvStates[key].job));
    if (!activeKeys.length) return undefined;
    const timer = window.setTimeout(() => {
      for (const key of activeKeys) void loadLatestCsvExport(key);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [csvStates, loadLatestCsvExport]);

  useEffect(() => {
    const dialog = editDialogRef.current;
    if (!dialog) return;
    if (editing && !dialog.open) dialog.showModal();
    if (!editing && dialog.open) dialog.close();
  }, [editing]);

  useEffect(() => {
    const dialog = createDialogRef.current;
    if (!dialog) return;
    if (createMode && !dialog.open) dialog.showModal();
    if (!createMode && dialog.open) dialog.close();
  }, [createMode]);

  const catalogSummary = useMemo(() => {
    const filters: string[] = [];
    if (catalogApplied.q.trim()) filters.push(`検索「${catalogApplied.q.trim()}」`);
    if (catalogApplied.manufacturerId.trim()) {
      filters.push(`メーカー ${catalogApplied.manufacturerId.trim()}`);
    }
    if (catalogApplied.categoryId) filters.push(categoryName(catalogApplied.categoryId));
    return filters.length
      ? `${catalogItems.length}件表示 · ${filters.join(" · ")}`
      : `${catalogItems.length}件表示 · すべてのCatalog`;
  }, [catalogApplied, catalogItems.length, categoryName]);

  const candidateSummary = useMemo(() => {
    const filters: string[] = [];
    if (candidateApplied.q.trim()) filters.push(`検索「${candidateApplied.q.trim()}」`);
    if (candidateApplied.manufacturerId.trim()) {
      filters.push(`メーカー ${candidateApplied.manufacturerId.trim()}`);
    }
    if (candidateApplied.categoryId) filters.push(categoryName(candidateApplied.categoryId));
    return filters.length
      ? `${candidateItems.length}件表示 · ${filters.join(" · ")}`
      : `${candidateItems.length}件表示 · 未検証候補`;
  }, [candidateApplied, candidateItems.length, categoryName]);

  const duplicateSummary = useMemo(() => {
    const scope = duplicateManufacturerApplied.trim()
      ? `メーカー ${duplicateManufacturerApplied.trim()}`
      : "すべてのメーカー";
    const catalogCount = duplicateItems.reduce((total, group) => total + group.products.length, 0);
    return `${duplicateItems.length}グループ · Catalog ${catalogCount}件 · ${scope}`;
  }, [duplicateItems, duplicateManufacturerApplied]);

  const editDirty = Boolean(
    editing &&
    (editName.trim() !== editing.canonicalName ||
      editCategory !== editing.primaryCategoryId ||
      editLifecycle !== editing.lifecycleStatus),
  );

  const openEdit = (product: CatalogProduct) => {
    setEditing(product);
    setEditName(product.canonicalName);
    setEditCategory(product.primaryCategoryId);
    setEditLifecycle(product.lifecycleStatus);
    setEditWarning(false);
    setMergeSourceId("");
    setMergeStatus("");
  };

  const openCreate = (candidate: CatalogCandidate | null) => {
    const manufacturer = candidate?.observedManufacturer || candidate?.manufacturerId || "";
    const model = candidate?.observedModel || candidate?.normalizedModel || "";
    const primaryCategoryId =
      candidate?.candidateCategoryIds.find((id) =>
        categories.some((category) => category.id === id && category.classifiable),
      ) || "";
    setCreateDraft({
      manufacturerId: candidate?.manufacturerId || "",
      canonicalModel: model,
      canonicalName: candidate ? `${manufacturer} ${model}`.trim() : "",
      primaryCategoryId,
      lifecycleStatus: "unknown",
      sourceUrl: candidate?.sourceUrl || "",
    });
    setCreateMode({ candidate });
  };

  const submitCatalogSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCatalogApplied(catalogDraft);
    void loadCatalog(catalogDraft, 0, []);
  };

  const submitCandidateSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setCandidateApplied(candidateDraft);
    void loadCandidates(candidateDraft, 0, []);
  };

  const submitDuplicateSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDuplicateManufacturerApplied(duplicateManufacturerDraft);
    void loadDuplicates(duplicateManufacturerDraft, "", []);
  };

  const saveEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!editing || !editDirty || editSaving) return;
    const canonicalName = editName.trim();
    if (!canonicalName || !editCategory) {
      setStatus({ text: "表示名とカテゴリは必須です。", kind: "error" });
      return;
    }
    setEditSaving(true);
    try {
      const result = await adminJson<CatalogUpdateResponse>(
        `/api/admin/knowledge-catalog/products/${editing.id}`,
        {
          method: "PATCH",
          body: JSON.stringify({
            canonicalName,
            primaryCategoryId: editCategory,
            lifecycleStatus: editLifecycle,
          }),
        },
      );
      setEditing(null);
      await loadCatalog(catalogApplied, catalogAfterId, catalogHistory);
      setStatus({
        text: `保存しました。紐づく${result.refreshedListings}件のlistingを再投影しました。`,
        kind: "success",
      });
    } catch (error) {
      setStatus({ text: `保存できません: ${catalogErrorText(error)}`, kind: "error" });
    } finally {
      setEditSaving(false);
    }
  };

  const submitManualCatalog = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!createMode || operationBusy) return;
    const payload = {
      manufacturerId: createDraft.manufacturerId.trim(),
      canonicalModel: createDraft.canonicalModel.trim(),
      canonicalName: createDraft.canonicalName.trim(),
      primaryCategoryId: createDraft.primaryCategoryId,
      lifecycleStatus: createDraft.lifecycleStatus,
      sourceUrl: createDraft.sourceUrl.trim(),
    };
    if (
      !payload.manufacturerId ||
      !payload.canonicalModel ||
      !payload.canonicalName ||
      !payload.primaryCategoryId
    ) {
      setStatus({ text: "メーカー、型番、表示名、カテゴリは必須です。", kind: "error" });
      return;
    }
    setOperationBusy(true);
    const candidate = createMode.candidate;
    try {
      const endpoint = candidate
        ? `/api/admin/knowledge-catalog/candidates/${candidate.id}/verify`
        : "/api/admin/knowledge-catalog/products";
      const result = await adminJson<ManualWriteResponse>(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      setCreateMode(null);
      if (candidate) {
        await loadCandidates(candidateApplied, candidateAfterId, candidateHistory);
      } else {
        await loadCatalog(catalogApplied, 0, []);
      }
      const resultText = result.matchedExisting
        ? `既存Catalog #${result.product.id} に候補を紐付けました。`
        : result.created
          ? `Catalog #${result.product.id} を手動追加しました。`
          : `Catalog #${result.product.id} を手動Verifyしました。`;
      const replayText = result.replayComplete
        ? `${result.replayedListings}件を再評価し、${result.newlyMatchedListings}件が一致しました。`
        : `${result.replayedListings}件を再評価し、残りは通常のremediationで継続します。`;
      setStatus({ text: `${resultText} ${replayText}`, kind: "success" });
    } catch (error) {
      setStatus({ text: `手動登録できません: ${catalogErrorText(error)}`, kind: "error" });
    } finally {
      setOperationBusy(false);
    }
  };

  const mergeCatalog = async () => {
    if (!editing || operationBusy) return;
    const sourceId = Number(mergeSourceId);
    if (!Number.isSafeInteger(sourceId) || sourceId <= 0 || sourceId === editing.id) {
      setMergeStatus("統合元には、現在のCatalogとは異なる有効なIDを入力してください。");
      return;
    }
    if (
      !window.confirm(
        `Catalog #${sourceId} を Catalog #${editing.id} へ統合します。\n\n#${editing.id} を残し、#${sourceId} は削除されます。alias・source・検証履歴・Product Identityは残す側へ移します。続行しますか？`,
      )
    ) {
      return;
    }
    setOperationBusy(true);
    setMergeStatus("統合しています…");
    try {
      const result = await adminJson<MergeResponse>(
        `/api/admin/knowledge-catalog/products/${editing.id}/merge`,
        { method: "POST", body: JSON.stringify({ sourceProductId: sourceId }) },
      );
      setEditing(null);
      await loadCatalog(catalogApplied, 0, []);
      const replayText = result.replayComplete
        ? "再投影も完了しました。"
        : "残りの再投影は通常のremediationで継続します。";
      setStatus({
        text: `Catalog #${result.removedProductId} を #${result.targetProductId} に統合しました。${result.movedMatchedListings}件の一致済みlistingを移行し、${result.replayedListings}件を再評価しました。${replayText}`,
        kind: "success",
      });
    } catch (error) {
      const text = catalogErrorText(error);
      setMergeStatus(`統合できません: ${text}`);
      setStatus({ text: `Catalogを統合できません: ${text}`, kind: "error" });
    } finally {
      setOperationBusy(false);
    }
  };

  const mergeDuplicateGroup = async (group: DuplicateGroup) => {
    if (operationBusy) return;
    const targetId = duplicateTargets[group.groupKey] ?? group.suggestedTargetId;
    const sources = group.products.filter((product) => product.id !== targetId);
    if (!sources.length) return;
    const sourceLabel = sources.map((product) => `#${product.id}`).join(", ");
    if (
      !window.confirm(
        `Catalog ${sourceLabel} を Catalog #${targetId} へ統合します。\n\n#${targetId} を残し、${sources.length}件は削除されます。alias・source・検証履歴・Product Identityは残す側へ移します。続行しますか？`,
      )
    ) {
      return;
    }
    setOperationBusy(true);
    setMergingGroupKey(group.groupKey);
    let mergedCount = 0;
    let movedListings = 0;
    try {
      // One request per source: each merge replays the surviving Catalog, so a failure part-way
      // leaves the merges already applied consistent instead of half-written.
      for (const source of sources) {
        const result = await adminJson<MergeResponse>(
          `/api/admin/knowledge-catalog/products/${targetId}/merge`,
          { method: "POST", body: JSON.stringify({ sourceProductId: source.id }) },
        );
        mergedCount += 1;
        movedListings += result.movedMatchedListings;
      }
      setStatus({
        text: `Catalog #${targetId} に${mergedCount}件を統合し、${movedListings}件の一致済みlistingを移行しました。`,
        kind: "success",
      });
    } catch (error) {
      const text = catalogErrorText(error);
      setStatus({
        text: mergedCount
          ? `${mergedCount}件を統合しましたが、残りを統合できません: ${text}`
          : `Catalogを統合できません: ${text}`,
        kind: "error",
      });
    } finally {
      setOperationBusy(false);
      setMergingGroupKey("");
      await loadDuplicates(duplicateManufacturerApplied, duplicateAfterKey, duplicateHistory);
      await loadCatalog(catalogApplied, catalogAfterId, catalogHistory);
    }
  };

  const generateCsvExport = async (key: CsvExportKey) => {
    const current = csvStates[key];
    if (current.busy || csvExportActive(current.job)) return;
    setCsvStates((states) => ({
      ...states,
      [key]: { ...states[key], busy: true, error: "" },
    }));
    try {
      const config = CSV_EXPORT_CONFIG[key];
      const job = await adminJson<CsvExportJob>(config.collectionUrl, {
        method: "POST",
        body: JSON.stringify(config.startBody),
      });
      setCsvStates((states) => ({
        ...states,
        [key]: { job, busy: false, error: "" },
      }));
    } catch (error) {
      setCsvStates((states) => ({
        ...states,
        [key]: {
          ...states[key],
          busy: false,
          error: `CSVの生成を開始できません: ${genericErrorText(error)}`,
        },
      }));
    }
  };

  const classifiableCategories = categories.filter((category) => category.classifiable);
  const filterableCategories = categories.filter((category) => category.filterable);

  return (
    <section
      id="catalog-pane"
      className="admin-pane"
      role="tabpanel"
      aria-labelledby="admin-tab-catalog"
    >
      <div className="admin-pane-heading">
        <div>
          <p className="eyebrow">CATALOG OPERATIONS</p>
          <h2>Knowledge Catalog 管理</h2>
          <p>検証済みCatalogの表示名・カテゴリ・ライフサイクルを検索・修正します。</p>
        </div>
      </div>
      <p className="status-message" role="status" aria-live="polite" data-kind={status.kind}>
        {status.text}
      </p>

      {catalogReady ? (
        <>
          <section className="panel workspace-panel" aria-labelledby="catalog-search-heading">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">CATALOG WORKSPACE</p>
                <h2 id="catalog-search-heading">Catalogを検索・編集</h2>
                <p>製品名・型番・メーカー・カテゴリを組み合わせて対象を絞り込めます。</p>
              </div>
              <div className="header-actions">
                <span className="keyboard-hint">
                  <kbd>Enter</kbd> で検索
                </span>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={operationBusy}
                  onClick={() => openCreate(null)}
                >
                  ＋ Catalogを追加
                </button>
              </div>
            </div>
            <form className="search-grid" onSubmit={submitCatalogSearch}>
              <label className="search-field search-field-wide">
                <span>製品を検索</span>
                <input
                  id="catalog-catalog-query"
                  type="search"
                  placeholder="製品名 / 型番 / manufacturer id"
                  autoComplete="off"
                  value={catalogDraft.q}
                  disabled={catalogBusy}
                  onChange={(event) =>
                    setCatalogDraft((value) => ({ ...value, q: event.currentTarget.value }))
                  }
                />
              </label>
              <label className="search-field">
                <span>Manufacturer ID</span>
                <input
                  id="catalog-manufacturer-id"
                  type="text"
                  placeholder="luxman"
                  spellCheck={false}
                  autoComplete="off"
                  value={catalogDraft.manufacturerId}
                  disabled={catalogBusy}
                  onChange={(event) =>
                    setCatalogDraft((value) => ({
                      ...value,
                      manufacturerId: event.currentTarget.value,
                    }))
                  }
                />
              </label>
              <label className="search-field">
                <span>カテゴリ</span>
                <select
                  id="catalog-category-filter"
                  value={catalogDraft.categoryId}
                  disabled={catalogBusy}
                  onChange={(event) =>
                    setCatalogDraft((value) => ({
                      ...value,
                      categoryId: event.currentTarget.value,
                    }))
                  }
                >
                  <option value="">すべてのカテゴリ</option>
                  {filterableCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="search-actions">
                <button
                  className="tertiary-button"
                  type="button"
                  disabled={
                    catalogBusy || !Object.values(catalogDraft).some((value) => value.trim())
                  }
                  onClick={() => {
                    setCatalogDraft(EMPTY_FILTERS);
                    setCatalogApplied(EMPTY_FILTERS);
                    void loadCatalog(EMPTY_FILTERS, 0, []);
                  }}
                >
                  条件をクリア
                </button>
                <button type="submit" disabled={catalogBusy}>
                  検索
                </button>
              </div>
            </form>
          </section>

          <section
            className={`panel table-panel${catalogBusy ? " is-loading" : ""}`}
            aria-label="Knowledge Catalog 一覧"
            aria-busy={catalogBusy}
          >
            <div className="table-toolbar">
              <div>
                <p className="eyebrow">VERIFIED</p>
                <h2>Catalog一覧</h2>
              </div>
              <p className="result-summary" aria-live="polite">
                {catalogSummary}
              </p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>メーカー</th>
                    <th>型番</th>
                    <th>表示名</th>
                    <th>カテゴリ</th>
                    <th>状態</th>
                    <th>listing</th>
                    <th>更新日時</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogItems.map((product) => (
                    <tr key={product.id} data-catalog-id={product.id}>
                      <td data-label="ID" className="id-cell">
                        {product.id}
                      </td>
                      <td data-label="メーカー">{product.manufacturerId}</td>
                      <td data-label="型番" className="model-cell">
                        {product.canonicalModel}
                      </td>
                      <td data-label="表示名" className="name-cell">
                        {product.canonicalName}
                      </td>
                      <td data-label="カテゴリ">
                        <span className="category-badge">
                          {categoryName(product.primaryCategoryId)}
                        </span>
                      </td>
                      <td data-label="状態">
                        <span
                          className={`lifecycle-badge ${lifecycleClass(product.lifecycleStatus)}`}
                        >
                          {lifecycleName(product.lifecycleStatus)}
                        </span>
                      </td>
                      <td data-label="listing">
                        <span className="count-badge">{product.matchedListingCount}</span>
                      </td>
                      <td data-label="更新日時" className="updated-cell">
                        {dateText(product.updatedAt)}
                      </td>
                      <td data-label="操作" className="row-actions">
                        <button
                          type="button"
                          className="secondary-button compact"
                          aria-label={`${product.canonicalName} を編集`}
                          onClick={() => openEdit(product)}
                        >
                          編集
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!catalogItems.length ? (
              <p className="empty-state">
                <strong>条件に一致するCatalogがありません。</strong>
                <span>検索条件を減らすか、条件をクリアして再検索してください。</span>
              </p>
            ) : null}
            <div className="pagination-bar">
              <span>ページ {catalogHistory.length + 1}</span>
              <nav className="pagination" aria-label="Catalogページング">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={catalogBusy || !catalogHistory.length}
                  onClick={() => {
                    const previous = catalogHistory.at(-1);
                    if (previous !== undefined)
                      void loadCatalog(catalogApplied, previous, catalogHistory.slice(0, -1));
                  }}
                >
                  ← 前へ
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={catalogBusy || catalogNextAfterId === null}
                  onClick={() => {
                    if (catalogNextAfterId !== null)
                      void loadCatalog(catalogApplied, catalogNextAfterId, [
                        ...catalogHistory,
                        catalogAfterId,
                      ]);
                  }}
                >
                  次へ →
                </button>
              </nav>
            </div>
          </section>

          <section
            className={`panel workspace-panel${duplicateBusy ? " is-loading" : ""}`}
            aria-labelledby="duplicate-heading"
            aria-busy={duplicateBusy}
          >
            <div className="panel-heading">
              <div>
                <p className="eyebrow">DUPLICATE CATALOGS</p>
                <h2 id="duplicate-heading">同一製品の重複Catalogを統合</h2>
                <p>
                  区切り記号・改訂表記・旧manufacturer
                  idの違いだけで別Catalogになった検証済みレコードをまとめます。残すCatalogを選ぶと、他のalias・source・検証履歴・Product
                  Identityがそこへ移り、重複側は削除されます。
                </p>
              </div>
            </div>
            <form className="search-grid duplicate-search" onSubmit={submitDuplicateSearch}>
              <label className="search-field">
                <span>Manufacturer ID</span>
                <input
                  type="text"
                  placeholder="luxman"
                  spellCheck={false}
                  autoComplete="off"
                  value={duplicateManufacturerDraft}
                  disabled={duplicateBusy || operationBusy}
                  onChange={(event) => setDuplicateManufacturerDraft(event.currentTarget.value)}
                />
              </label>
              <div className="search-actions">
                <button
                  className="tertiary-button"
                  type="button"
                  disabled={duplicateBusy || operationBusy || !duplicateManufacturerDraft.trim()}
                  onClick={() => {
                    setDuplicateManufacturerDraft("");
                    setDuplicateManufacturerApplied("");
                    void loadDuplicates("", "", []);
                  }}
                >
                  条件をクリア
                </button>
                <button type="submit" disabled={duplicateBusy || operationBusy}>
                  重複を再検出
                </button>
              </div>
            </form>
            <div className="table-toolbar">
              <div>
                <p className="eyebrow">REVIEW</p>
                <h2>重複候補</h2>
              </div>
              <p className="result-summary" aria-live="polite">
                {duplicateSummary}
              </p>
            </div>
            <div className="duplicate-groups">
              {duplicateItems.map((group) => {
                const targetId = duplicateTargets[group.groupKey] ?? group.suggestedTargetId;
                const merging = mergingGroupKey === group.groupKey;
                return (
                  <article className="duplicate-group" key={group.groupKey}>
                    <div className="duplicate-group-heading">
                      <div>
                        <p className="eyebrow">{group.manufacturerId}</p>
                        <h3>{group.identityModel}</h3>
                      </div>
                      <span className="count-badge">{group.products.length}件</span>
                    </div>
                    <div className="table-wrap">
                      <table>
                        <thead>
                          <tr>
                            <th>残す</th>
                            <th>ID</th>
                            <th>メーカー</th>
                            <th>型番</th>
                            <th>表示名</th>
                            <th>カテゴリ</th>
                            <th>状態</th>
                            <th>listing</th>
                            <th>alias/source</th>
                            <th>更新日時</th>
                          </tr>
                        </thead>
                        <tbody>
                          {group.products.map((product) => (
                            <tr
                              key={product.id}
                              data-catalog-id={product.id}
                              data-merge-target={product.id === targetId ? "true" : "false"}
                            >
                              <td data-label="残す">
                                <input
                                  type="radio"
                                  name={`duplicate-target-${group.groupKey}`}
                                  value={product.id}
                                  checked={product.id === targetId}
                                  disabled={duplicateBusy || operationBusy}
                                  aria-label={`Catalog #${product.id} を残す`}
                                  onChange={() =>
                                    setDuplicateTargets((targets) => ({
                                      ...targets,
                                      [group.groupKey]: product.id,
                                    }))
                                  }
                                />
                              </td>
                              <td data-label="ID" className="id-cell">
                                {product.id}
                              </td>
                              <td data-label="メーカー">{product.manufacturerId}</td>
                              <td data-label="型番" className="model-cell">
                                {product.canonicalModel}
                              </td>
                              <td data-label="表示名" className="name-cell">
                                {product.canonicalName}
                              </td>
                              <td data-label="カテゴリ">
                                <span className="category-badge">
                                  {categoryName(product.primaryCategoryId)}
                                </span>
                              </td>
                              <td data-label="状態">
                                <span
                                  className={`lifecycle-badge ${lifecycleClass(product.lifecycleStatus)}`}
                                >
                                  {lifecycleName(product.lifecycleStatus)}
                                </span>
                              </td>
                              <td data-label="listing">
                                <span className="count-badge">{product.matchedListingCount}</span>
                              </td>
                              <td data-label="alias/source">
                                {product.aliasCount} / {product.sourceCount}
                              </td>
                              <td data-label="更新日時" className="updated-cell">
                                {dateText(product.updatedAt)}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="duplicate-group-actions">
                      <p className="duplicate-group-note">
                        Catalog #{targetId} を残し、他の{group.products.length - 1}
                        件をここへ統合します。
                      </p>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={duplicateBusy || operationBusy}
                        onClick={() => void mergeDuplicateGroup(group)}
                      >
                        {merging ? "統合しています…" : "このグループを統合"}
                      </button>
                    </div>
                  </article>
                );
              })}
            </div>
            {!duplicateItems.length ? (
              <p className="empty-state">
                <strong>統合が必要な重複Catalogはありません。</strong>
                <span>
                  {duplicateNextAfterKey !== null
                    ? "このページには該当がありませんでした。次へで続きを確認してください。"
                    : "同一製品を指す検証済みCatalogは見つかりませんでした。"}
                </span>
              </p>
            ) : null}
            <div className="pagination-bar">
              <span>ページ {duplicateHistory.length + 1}</span>
              <nav className="pagination" aria-label="重複Catalogページング">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={duplicateBusy || operationBusy || !duplicateHistory.length}
                  onClick={() => {
                    const previous = duplicateHistory.at(-1);
                    if (previous !== undefined) {
                      void loadDuplicates(
                        duplicateManufacturerApplied,
                        previous,
                        duplicateHistory.slice(0, -1),
                      );
                    }
                  }}
                >
                  ← 前へ
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={duplicateBusy || operationBusy || duplicateNextAfterKey === null}
                  onClick={() => {
                    if (duplicateNextAfterKey !== null) {
                      void loadDuplicates(duplicateManufacturerApplied, duplicateNextAfterKey, [
                        ...duplicateHistory,
                        duplicateAfterKey,
                      ]);
                    }
                  }}
                >
                  次へ →
                </button>
              </nav>
            </div>
          </section>

          <section className="panel workspace-panel" aria-labelledby="candidate-search-heading">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">MANUAL VERIFICATION</p>
                <h2 id="candidate-search-heading">未検証候補を確認</h2>
                <p>
                  自動VerifyでCatalogへ昇格できなかった候補を検索し、人手で確認して検証済みにできます。
                </p>
              </div>
            </div>
            <form className="search-grid" onSubmit={submitCandidateSearch}>
              <label className="search-field search-field-wide">
                <span>候補を検索</span>
                <input
                  type="search"
                  placeholder="製品名 / 型番 / manufacturer id"
                  autoComplete="off"
                  value={candidateDraft.q}
                  disabled={candidateBusy || operationBusy}
                  onChange={(event) =>
                    setCandidateDraft((value) => ({ ...value, q: event.currentTarget.value }))
                  }
                />
              </label>
              <label className="search-field">
                <span>Manufacturer ID</span>
                <input
                  type="text"
                  placeholder="mark-levinson"
                  spellCheck={false}
                  autoComplete="off"
                  value={candidateDraft.manufacturerId}
                  disabled={candidateBusy || operationBusy}
                  onChange={(event) =>
                    setCandidateDraft((value) => ({
                      ...value,
                      manufacturerId: event.currentTarget.value,
                    }))
                  }
                />
              </label>
              <label className="search-field">
                <span>カテゴリ</span>
                <select
                  value={candidateDraft.categoryId}
                  disabled={candidateBusy || operationBusy}
                  onChange={(event) =>
                    setCandidateDraft((value) => ({
                      ...value,
                      categoryId: event.currentTarget.value,
                    }))
                  }
                >
                  <option value="">すべてのカテゴリ</option>
                  {filterableCategories.map((category) => (
                    <option key={category.id} value={category.id}>
                      {category.name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="search-actions">
                <button
                  className="tertiary-button"
                  type="button"
                  disabled={
                    candidateBusy ||
                    operationBusy ||
                    !Object.values(candidateDraft).some((value) => value.trim())
                  }
                  onClick={() => {
                    setCandidateDraft(EMPTY_FILTERS);
                    setCandidateApplied(EMPTY_FILTERS);
                    void loadCandidates(EMPTY_FILTERS, 0, []);
                  }}
                >
                  条件をクリア
                </button>
                <button type="submit" disabled={candidateBusy || operationBusy}>
                  候補を検索
                </button>
              </div>
            </form>
            <div className="table-toolbar">
              <div>
                <p className="eyebrow">PENDING</p>
                <h2>未検証候補</h2>
              </div>
              <p className="result-summary" aria-live="polite">
                {candidateSummary}
              </p>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>メーカー</th>
                    <th>型番</th>
                    <th>サンプル</th>
                    <th>カテゴリ</th>
                    <th>状態</th>
                    <th>listing</th>
                    <th>更新日時</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {candidateItems.map((candidate) => {
                    const manufacturer = candidate.observedManufacturer || candidate.manufacturerId;
                    const model = candidate.observedModel || candidate.normalizedModel;
                    const primaryCategory =
                      candidate.candidateCategoryIds.find((id) =>
                        categories.some((category) => category.id === id && category.classifiable),
                      ) || "";
                    return (
                      <tr key={candidate.id}>
                        <td data-label="ID" className="id-cell">
                          {candidate.id}
                        </td>
                        <td data-label="メーカー">{manufacturer}</td>
                        <td data-label="型番" className="model-cell">
                          {model}
                        </td>
                        <td data-label="サンプル" className="name-cell">
                          {candidate.sampleTitle || `${manufacturer} ${model}`.trim()}
                        </td>
                        <td data-label="カテゴリ">
                          <span className="category-badge">{categoryName(primaryCategory)}</span>
                        </td>
                        <td data-label="状態">
                          <span className="lifecycle-badge lifecycle-unknown">
                            {candidateStatus(candidate.verificationStatus)}
                          </span>
                        </td>
                        <td data-label="listing">
                          <span className="count-badge">{candidate.activeListingCount}</span>
                        </td>
                        <td data-label="更新日時" className="updated-cell">
                          {dateText(candidate.updatedAt)}
                        </td>
                        <td data-label="操作" className="row-actions">
                          <button
                            type="button"
                            className="secondary-button compact"
                            disabled={operationBusy}
                            onClick={() => openCreate(candidate)}
                          >
                            手動Verify
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!candidateItems.length ? (
              <p className="empty-state">
                <strong>条件に一致する未検証候補がありません。</strong>
                <span>検索条件を減らすか、Catalog一覧も確認してください。</span>
              </p>
            ) : null}
            <div className="pagination-bar">
              <span>ページ {candidateHistory.length + 1}</span>
              <nav className="pagination" aria-label="未検証候補ページング">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={candidateBusy || operationBusy || !candidateHistory.length}
                  onClick={() => {
                    const previous = candidateHistory.at(-1);
                    if (previous !== undefined)
                      void loadCandidates(
                        candidateApplied,
                        previous,
                        candidateHistory.slice(0, -1),
                      );
                  }}
                >
                  ← 前へ
                </button>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={candidateBusy || operationBusy || candidateNextAfterId === null}
                  onClick={() => {
                    if (candidateNextAfterId !== null)
                      void loadCandidates(candidateApplied, candidateNextAfterId, [
                        ...candidateHistory,
                        candidateAfterId,
                      ]);
                  }}
                >
                  次へ →
                </button>
              </nav>
            </div>
          </section>

          <details className="panel export-panel">
            <summary className="export-summary">
              <span className="export-summary-copy">
                <span className="eyebrow">AI DATA AUDIT</span>
                <strong>カタログと登録商品をCSVで診断</strong>
                <span>Catalog・重複・カテゴリ・メーカー/型番の品質確認用データを生成します。</span>
              </span>
              <span className="summary-chevron" aria-hidden="true" />
            </summary>
            <div className="export-content">
              <p className="export-description">
                Knowledge Catalogは検証状態やカテゴリ・alias・source・Product
                Identityを1行1製品で、登録商品は店舗ごとの生データや検索上の同一製品グループを1行1listingで出力します。CSVをAIに渡して、重複表示・カテゴリ誤り・メーカー/型番の正規化漏れを確認できます。
              </p>
              <div className="export-jobs">
                {CSV_EXPORT_KEYS.map((key) => (
                  <CsvExportCard
                    key={key}
                    config={CSV_EXPORT_CONFIG[key]}
                    state={csvStates[key]}
                    onGenerate={() => void generateCsvExport(key)}
                  />
                ))}
              </div>
              <p className="export-note">
                Knowledge
                Catalogは100件ずつ、登録商品は250件ずつバックグラウンドで処理し、画面を閉じても継続します。通常の商品監査には「掲載中商品」を推奨し、「全履歴」には販売終了・非掲載の商品も含まれます。完成したCSVは7日間ダウンロードできます。
              </p>
            </div>
          </details>
        </>
      ) : null}

      <dialog
        ref={editDialogRef}
        onClose={() => setEditing(null)}
        onCancel={(event) => {
          if (editDirty) {
            event.preventDefault();
            setEditWarning(true);
          }
        }}
      >
        {editing ? (
          <form className="edit-form" onSubmit={(event) => void saveEdit(event)}>
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">EDIT CATALOG</p>
                <h2>Catalog情報を修正</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="編集画面を閉じる"
                onClick={() => setEditing(null)}
              >
                ×
              </button>
            </div>
            <div className="identity-card">
              <span>変更対象</span>
              <p className="identity">
                {editing.manufacturerId} / {editing.canonicalModel} (#{editing.id})
              </p>
              <p className="identity-note">
                メーカーと型番を変える場合は、正しいCatalogを追加してから重複統合を利用してください。
              </p>
            </div>
            <label>
              <span>表示名</span>
              <input
                type="text"
                maxLength={300}
                required
                value={editName}
                onChange={(event) => {
                  setEditName(event.currentTarget.value);
                  setEditWarning(false);
                }}
              />
            </label>
            <label>
              <span>主カテゴリ</span>
              <select
                required
                value={editCategory}
                onChange={(event) => {
                  setEditCategory(event.currentTarget.value);
                  setEditWarning(false);
                }}
              >
                {classifiableCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>ライフサイクル</span>
              <select
                required
                value={editLifecycle}
                onChange={(event) => {
                  setEditLifecycle(event.currentTarget.value as LifecycleStatus);
                  setEditWarning(false);
                }}
              >
                <option value="unknown">不明</option>
                <option value="active">現行</option>
                <option value="discontinued">生産完了</option>
              </select>
            </label>
            <div className="edit-impact">
              <strong>保存時の処理</strong>
              <p>このCatalogに一致済みのlistingも再分類・再投影されます。</p>
            </div>
            <p
              className="edit-change-status"
              data-dirty={editWarning ? "warning" : editDirty ? "true" : "false"}
            >
              {editWarning
                ? "未保存の変更があります。キャンセルで破棄できます。"
                : editDirty
                  ? "未保存の変更があります。"
                  : "変更すると保存できます。"}
            </p>
            <div className="dialog-actions">
              <button className="secondary-button" type="button" onClick={() => setEditing(null)}>
                キャンセル
              </button>
              <button type="submit" disabled={catalogBusy || editSaving || !editDirty}>
                {editSaving ? "保存中…" : "変更を保存"}
              </button>
            </div>
            <div className="edit-impact">
              <strong>重複CatalogをこのCatalogへ統合</strong>
              <p>
                統合元のalias・source・検証履歴・Product
                IdentityをこのCatalogへ移し、統合元Catalogを削除します。
              </p>
              <label>
                <span>統合元 Catalog ID</span>
                <input
                  type="number"
                  min="1"
                  step="1"
                  inputMode="numeric"
                  placeholder="例: 123"
                  value={mergeSourceId}
                  onChange={(event) => setMergeSourceId(event.currentTarget.value)}
                />
              </label>
              <p className="edit-change-status" data-dirty={mergeStatus ? "warning" : "false"}>
                {mergeStatus}
              </p>
              <div className="dialog-actions">
                <button
                  className="secondary-button"
                  type="button"
                  disabled={
                    operationBusy ||
                    !Number.isSafeInteger(Number(mergeSourceId)) ||
                    Number(mergeSourceId) <= 0 ||
                    Number(mergeSourceId) === editing.id
                  }
                  onClick={() => void mergeCatalog()}
                >
                  {operationBusy ? "処理中…" : "このCatalogへ統合"}
                </button>
              </div>
            </div>
          </form>
        ) : null}
      </dialog>

      <dialog ref={createDialogRef} onClose={() => setCreateMode(null)}>
        {createMode ? (
          <form className="edit-form" onSubmit={(event) => void submitManualCatalog(event)}>
            <div className="dialog-heading">
              <div>
                <p className="eyebrow">MANUAL VERIFICATION</p>
                <h2>{createMode.candidate ? "未検証候補を手動Verify" : "Catalogを手動追加"}</h2>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label="手動追加画面を閉じる"
                onClick={() => setCreateMode(null)}
              >
                ×
              </button>
            </div>
            {createMode.candidate ? (
              <div className="identity-card">
                <span>未検証候補</span>
                <p className="identity">
                  {createMode.candidate.observedManufacturer || createMode.candidate.manufacturerId}{" "}
                  / {createMode.candidate.observedModel || createMode.candidate.normalizedModel} (#
                  {createMode.candidate.id})
                </p>
                <p className="identity-note">{createMode.candidate.sampleTitle}</p>
              </div>
            ) : null}
            <label>
              <span>Manufacturer ID / メーカー名</span>
              <input
                type="text"
                maxLength={100}
                required
                autoComplete="off"
                value={createDraft.manufacturerId}
                onChange={(event) =>
                  setCreateDraft((value) => ({
                    ...value,
                    manufacturerId: event.currentTarget.value,
                  }))
                }
              />
            </label>
            <label>
              <span>型番</span>
              <input
                type="text"
                maxLength={200}
                required
                autoComplete="off"
                value={createDraft.canonicalModel}
                onChange={(event) =>
                  setCreateDraft((value) => ({
                    ...value,
                    canonicalModel: event.currentTarget.value,
                  }))
                }
              />
            </label>
            <label>
              <span>表示名</span>
              <input
                type="text"
                maxLength={300}
                required
                autoComplete="off"
                value={createDraft.canonicalName}
                onChange={(event) =>
                  setCreateDraft((value) => ({
                    ...value,
                    canonicalName: event.currentTarget.value,
                  }))
                }
              />
            </label>
            <label>
              <span>主カテゴリ</span>
              <select
                required
                value={createDraft.primaryCategoryId}
                onChange={(event) =>
                  setCreateDraft((value) => ({
                    ...value,
                    primaryCategoryId: event.currentTarget.value,
                  }))
                }
              >
                <option value="">カテゴリを選択</option>
                {classifiableCategories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>ライフサイクル</span>
              <select
                required
                value={createDraft.lifecycleStatus}
                onChange={(event) =>
                  setCreateDraft((value) => ({
                    ...value,
                    lifecycleStatus: event.currentTarget.value as LifecycleStatus,
                  }))
                }
              >
                <option value="unknown">不明</option>
                <option value="active">現行</option>
                <option value="discontinued">生産完了</option>
              </select>
            </label>
            <label>
              <span>確認元URL（任意）</span>
              <input
                type="url"
                maxLength={1000}
                placeholder="https://..."
                autoComplete="off"
                value={createDraft.sourceUrl}
                onChange={(event) =>
                  setCreateDraft((value) => ({ ...value, sourceUrl: event.currentTarget.value }))
                }
              />
            </label>
            <div className="edit-impact">
              <strong>手動Verifyとして記録</strong>
              <p>
                manual_verified sourceを残し、Product
                Identityの再評価と検索projection更新を実行します。
              </p>
            </div>
            <div className="dialog-actions">
              <button
                className="secondary-button"
                type="button"
                onClick={() => setCreateMode(null)}
              >
                キャンセル
              </button>
              <button type="submit" disabled={operationBusy}>
                {operationBusy
                  ? "処理中…"
                  : createMode.candidate
                    ? "候補を手動Verify"
                    : "検証済みとして登録"}
              </button>
            </div>
          </form>
        ) : null}
      </dialog>
    </section>
  );
}
