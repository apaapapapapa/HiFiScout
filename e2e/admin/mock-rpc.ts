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
    writes: { catalog: 0, listing: 0 },
    unexpectedCalls: [] as string[],
  };
  const unsupported = (method: string) => async () => {
    state.unexpectedCalls.push(method);
    throw new Error(`Unmocked admin RPC: ${method}`);
  };
  const rpc: AdminRpc = {
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
    applyCsvImport: unsupported("applyCsvImport"),
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
