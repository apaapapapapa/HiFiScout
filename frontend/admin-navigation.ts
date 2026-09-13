export const ADMIN_VIEWS = [
  {
    id: "ai",
    label: "AIの型番候補",
    description: "未解決の型番候補と根拠を確認し、提案の評価を記録します。",
  },
  {
    id: "quality",
    label: "品質点検",
    description: "再報告・未分類・照合の問題を、影響と優先度から確認します。",
  },
  {
    id: "manufacturers",
    label: "メーカー・別名",
    description: "正式名称・表記揺れの影響を確認し、履歴を残して修正します。",
  },
  {
    id: "extraction",
    label: "抽出テスト",
    description: "保存済み商品やタイトルで、抽出結果と仮の別名ルールを比較します。",
  },
  {
    id: "operations",
    label: "負荷・稼働状況",
    description: "保存済みの使用量・失敗・本番バージョンを確認します。",
  },
  {
    id: "jobs",
    label: "バックグラウンド処理",
    description:
      "カタログ・判定ルール・出品条件の再処理を開始し、CSVを含む各処理の進捗確認や停止・再開を行います。",
  },
  {
    id: "crawls",
    label: "ショップ別クロール",
    description: "ショップごとの収集状況・予定停止を確認し、停止・再開・再実行します。",
  },
  {
    id: "catalog",
    label: "製品カタログ",
    description: "メーカー共通の製品情報を検索・修正します。",
  },
  {
    id: "listings",
    label: "登録商品",
    description: "販売店ごとの商品情報・色・出品条件を確認して修正します。",
  },
  {
    id: "reports",
    label: "誤り報告",
    description: "利用者から届いた報告を確認し、対応状況を管理します。",
  },
  {
    id: "duplicates",
    label: "重複の整理",
    description: "同じ製品の候補を比較し、残すカタログを選んで統合します。",
  },
  {
    id: "candidates",
    label: "未検証候補",
    description: "販売店から見つかった候補を確認し、カタログに登録します。",
  },
  {
    id: "csv",
    label: "CSV入出力",
    description: "データをダウンロードし、編集したCSVの差分を確認して一括更新します。",
  },
] as const;

export type AdminView = (typeof ADMIN_VIEWS)[number]["id"];
export const ADMIN_WORKSPACES = [
  {
    id: "catalog",
    label: "カタログ管理",
    views: ["catalog", "candidates", "duplicates", "ai", "manufacturers"],
  },
  { id: "listings", label: "商品管理", views: ["listings", "extraction"] },
  { id: "quality", label: "品質管理", views: ["quality", "reports"] },
  { id: "bulk", label: "一括処理", views: ["jobs", "csv"] },
  { id: "operations", label: "稼働管理", views: ["operations", "crawls"] },
] as const satisfies readonly { id: string; label: string; views: readonly AdminView[] }[];

export function adminWorkspace(view: AdminView) {
  return ADMIN_WORKSPACES.find((workspace) => workspace.views.some((id) => id === view))!;
}

export type CatalogView = "catalog" | "duplicates" | "candidates" | "csv";

export function isCatalogView(view: AdminView): view is CatalogView {
  return view === "catalog" || view === "duplicates" || view === "candidates" || view === "csv";
}

export function adminLocation(location: { hash: string; search: string }): {
  view: AdminView;
  search: string;
} {
  const hash = location.hash === "#maintenance" ? "#jobs" : location.hash;
  const view = ADMIN_VIEWS.find((item) => `#${item.id}` === hash)?.id ?? "catalog";
  return { view, search: location.search };
}

export function adminViewUrl(href: string, view: AdminView): string {
  const url = new URL(href);
  for (const key of [
    "q",
    "shopKey",
    "scope",
    "manufacturerId",
    "categoryId",
    "jobId",
    "listingId",
    "reportId",
    "candidateId",
    "aiSuggestionId",
    "aiCandidateId",
  ])
    url.searchParams.delete(key);
  url.hash = view === "catalog" ? "" : view;
  return `${url.pathname}${url.search}${url.hash}`;
}
