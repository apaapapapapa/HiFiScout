import type { AdminChangeHistoryItem } from "../../src/api/admin-listing-contracts.js";
import type adminWorker from "../../src/admin/entry.js";

type AdminRpc = Parameters<typeof adminWorker.fetch>[1]["CATALOG_ADMIN"];

export function createMockAdminRpc() {
  const state = {
    catalog: {
      id: 11,
      manufacturerId: "luxman",
      canonicalModel: "D-1000",
      canonicalName: "LUXMAN D-1000",
      lifecycleStatus: "active",
      primaryCategoryId: "SRC.DISC",
      matchedListingCount: 1,
      updatedAt: "2026-08-26T00:00:00.000Z",
    },
    listing: {
      id: 21,
      shopKey: "audiounion",
      sourceId: "AU-21",
      sourceUrl: "https://example.test/products/21",
      isActive: true,
      stockStatus: "in_stock",
      priceYen: 980000,
      title: "LUXMAN D-1000 ブラック",
      rawManufacturer: "LUXMAN",
      manufacturer: "LUXMAN",
      manufacturerId: "luxman",
      canonicalManufacturerId: "luxman",
      rawModel: "D-1000",
      model: "D-1000",
      normalizedModel: "D1000",
      rawCategory: "デジタルプレーヤー",
      category: "ディスクプレーヤー",
      primaryCategoryId: "SRC.DISC",
      classificationStatus: "classified",
      presentationColor: "ブラック",
      lastSeenAt: "2026-08-26T00:00:00.000Z",
      lastChangedAt: "2026-08-26T00:00:00.000Z",
      lastActivityAt: "2026-08-26T00:00:00.000Z",
      overrides: {
        manufacturerId: null,
        model: null,
        primaryCategoryId: null,
        presentationColor: null as string | null,
        updatedAt: null as string | null,
      },
    },
    history: [] as AdminChangeHistoryItem[],
    historyConflict: false,
    writes: { catalog: 0, listing: 0 },
    replay: { scannedCount: 0, totalCount: 550, stepCalls: 0 },
    unexpectedCalls: [] as string[],
  };
  const replayProgress = () => ({
    ruleVersion: 1,
    scannedCount: state.replay.scannedCount,
    activeCount: Math.max(0, state.replay.scannedCount - 1),
    completedAt:
      state.replay.scannedCount >= state.replay.totalCount ? "2026-09-07T00:00:00Z" : null,
    coverage: { byShop: [], byCategory: [] },
  });
  const unsupported = (method: string) => async () => {
    state.unexpectedCalls.push(method);
    throw new Error(`Unmocked admin RPC: ${method}`);
  };
  const rpc: AdminRpc = {
    getWorkCounts: async () => ({
      reports: 0,
      candidates: 0,
      duplicateIdentities: [],
      nextDuplicateCursor: null,
    }),
    async getListingDiagnosis(id) {
      if (id !== state.listing.id) return null;
      const p = state.listing;
      return {
        listingId: id,
        observedAt: p.lastSeenAt,
        seller: {
          title: p.title,
          manufacturer: p.rawManufacturer,
          model: p.rawModel,
          category: p.rawCategory,
          url: p.sourceUrl,
        },
        decision: {
          manufacturerId: p.canonicalManufacturerId,
          manufacturer: p.manufacturer,
          manufacturerStatus: "resolved",
          manufacturerMethod: "verified_alias",
          manufacturerConfidence: "high",
          model: p.model,
          normalizedModel: p.normalizedModel,
          modelStatus: "resolved",
          modelMethod: "seller_model",
          modelConfidence: "high",
          category: p.category,
          categoryId: p.primaryCategoryId,
          categoryStatus: p.classificationStatus,
          color: p.presentationColor,
        },
        overrides: {
          メーカー: null,
          型番: null,
          カテゴリ: null,
          色: p.overrides.presentationColor,
        },
        identity: {
          status: "unresolved",
          method: "none",
          confidence: "none",
          matchedFields: "[]",
          rejectedBy: '["category_conflict"]',
          evaluatedAt: p.lastSeenAt,
          catalogId: null,
          catalogName: null,
          candidateId: 11,
          candidateName: "候補のモデル",
        },
        search: {
          key: "l-21",
          kind: "unresolved_listing",
          model: p.model,
          categoryId: p.primaryCategoryId,
          offerCount: 1,
          pending: 0,
          active: 1,
        },
        peers: [
          {
            id,
            shop: p.shopKey,
            category: p.primaryCategoryId,
            modelStatus: "resolved",
            entityKey: "l-21",
          },
        ],
        peersHasMore: false,
      };
    },
    getChangeHistory: async () => ({ items: state.history, hasMore: false }),
    async previewHistoryRestore(selection) {
      if (state.historyConflict) return { status: "conflict", message: "後続の変更があります。" };
      const item = state.history.find((row) => row.operationId === selection.operationId);
      if (!item) return { status: "invalid", message: "履歴なし" };
      const original = {
        manufacturer_id: state.listing.canonicalManufacturerId,
        model: state.listing.model,
        primary_category_id: state.listing.primaryCategoryId,
      };
      return {
        status: "ready",
        message: "復元できます。",
        revision: "a".repeat(64),
        before: original.model,
        after: item.before.model,
        change: {
          line: 1,
          original: { version: 1, kind: "listing", id: state.listing.id, values: original },
          values: { ...original, model: item.before.model },
        },
      };
    },
    restoreHistoryColor: unsupported("restoreHistoryColor"),
    getModelFacts: unsupported("getModelFacts"),
    saveModelFacts: unsupported("saveModelFacts"),
    getOfferFactReplay: async () => (state.replay.stepCalls ? replayProgress() : null),
    async stepOfferFactReplay() {
      state.replay.stepCalls++;
      state.replay.scannedCount = Math.min(state.replay.scannedCount + 25, state.replay.totalCount);
      return replayProgress();
    },
    async listManufacturers({ query, afterId, limit }) {
      const matching = [
        { id: "accuphase", name: "Accuphase" },
        { id: "luxman", name: "LUXMAN" },
      ].filter(
        (item) =>
          item.id > afterId &&
          `${item.id} ${item.name}`.toLowerCase().includes(query.toLowerCase()),
      );
      const items = matching.slice(0, limit);
      const hasMore = matching.length > limit;
      return { items, hasMore, nextAfterId: hasMore ? items.at(-1)!.id : null };
    },
    getSpecifications: unsupported("getSpecifications"),
    updateSpecifications: unsupported("updateSpecifications"),
    getOfferFacts: unsupported("getOfferFacts"),
    updateOfferFacts: unsupported("updateOfferFacts"),
    async listProducts() {
      return { items: [state.catalog], nextAfterId: null };
    },
    async updateProduct(id, input) {
      if (id !== state.catalog.id) return null;
      state.catalog = { ...state.catalog, ...input };
      state.writes.catalog += 1;
      return { refreshedListings: 1 };
    },
    async listListings() {
      return { items: [state.listing], nextAfterId: null, hasMore: false };
    },
    async updateListing(id, input) {
      if (id !== state.listing.id) return null;
      state.listing = {
        ...state.listing,
        ...input,
        overrides: {
          ...state.listing.overrides,
          presentationColor: input.presentationColor ?? state.listing.overrides.presentationColor,
          updatedAt: new Date().toISOString(),
        },
      };
      state.writes.listing += 1;
      return { listing: state.listing, refreshedListings: 1 };
    },
    async listCandidates() {
      return { items: [], nextAfterId: null, hasMore: false };
    },
    async listDuplicates() {
      return { items: [], nextAfterKey: null, hasMore: false };
    },
    async listCorrectionReports() {
      return { items: [], nextAfterId: null, hasMore: false };
    },
    async latestKnowledgeCatalogExportJob() {
      return null;
    },
    async latestProductAuditExportJob() {
      return null;
    },
    previewCsvImport: unsupported("previewCsvImport"),
    async applyCsvImport(input) {
      if (!state.history.length) return unsupported("applyCsvImport")();
      state.listing.model = input.change.values.model;
      state.writes.listing++;
      return {
        status: "applied",
        message: "復元しました。",
        line: 1,
        id: state.listing.id,
        kind: "listing",
      };
    },
    createProduct: unsupported("createProduct"),
    verifyCandidate: unsupported("verifyCandidate"),
    mergeProducts: unsupported("mergeProducts"),
    updateCorrectionReport: unsupported("updateCorrectionReport"),
    startKnowledgeCatalogExport: unsupported("startKnowledgeCatalogExport"),
    getKnowledgeCatalogExportJob: unsupported("getKnowledgeCatalogExportJob"),
    downloadKnowledgeCatalogExport: unsupported("downloadKnowledgeCatalogExport"),
    startProductAuditExport: unsupported("startProductAuditExport"),
    getProductAuditExportJob: unsupported("getProductAuditExportJob"),
    downloadProductAuditExport: unsupported("downloadProductAuditExport"),
  };
  return { rpc, state };
}
