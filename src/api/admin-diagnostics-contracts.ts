export interface AdminListingDiagnosis {
  listingId: number;
  observedAt: string;
  seller: { title: string; manufacturer: string; model: string; category: string; url: string };
  decision: {
    manufacturerId: string;
    manufacturer: string;
    manufacturerStatus: string;
    manufacturerMethod: string;
    manufacturerConfidence: string;
    model: string;
    normalizedModel: string;
    modelStatus: string;
    modelMethod: string;
    modelConfidence: string;
    category: string;
    categoryId: string;
    categoryStatus: string;
    color: string;
  };
  overrides: Record<string, string | null>;
  identity: {
    status: string | null;
    method: string | null;
    confidence: string | null;
    matchedFields: string;
    rejectedBy: string;
    evaluatedAt: string | null;
    catalogId: number | null;
    catalogName: string | null;
    candidateId: number | null;
    candidateName: string | null;
  };
  search: {
    key: string | null;
    kind: string | null;
    model: string | null;
    categoryId: string | null;
    offerCount: number | null;
    pending: number;
    active: number;
  };
  peers: Array<{
    id: number;
    shop: string;
    category: string;
    modelStatus: string;
    entityKey: string | null;
  }>;
  peersHasMore: boolean;
}
