/**
 * Crawler domain vocabulary: the shop-adapter contract, the HTML transport contract, the
 * environment view the config helpers accept, and the status-tagged result unions.
 *
 * Type-only imports go one way (`crawler -> db -> catalog`) so `^src` stays acyclic.
 */

import type {
  CategoryEvidenceInput,
  CategoryMapping,
  CategoryPolicyInput,
  FeatureFactInput,
  NormalizedCatalogProduct,
  StockStatus,
} from "../catalog/types.js";
import type { ProductActivityPolicy } from "../db/product-activity-policy.js";
import type {
  IdentitySyncMetrics,
  ProductSearchEntitySyncResult,
  QualityEvaluation,
  QualityThreshold,
  QueryableDatabase,
  ShopSyncStateRow,
} from "../db/types.js";

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Binding members of the generated `Env`; everything else in it is a string var. */
export type EnvBindingName =
  | "EVIDENCE_BUCKET"
  | "DB"
  | "CRAWL_QUEUE"
  | "CRAWL_FAST_QUEUE"
  | "CRAWL_HEAVY_QUEUE"
  | "CRAWL_RELAY_QUEUE"
  | "KNOWLEDGE_CATALOG_QUEUE"
  | "PRODUCT_AUDIT_EXPORT_QUEUE"
  | "API_RATE_LIMITER"
  | "BROWSER"
  | "ASSETS";

/** Every `vars` entry declared in `wrangler.jsonc`, taken straight from the generated `Env`. */
export type GeneratedEnvVarName = Exclude<keyof Env, EnvBindingName>;

/** Wrangler secrets: real at runtime, absent from the generated `Env`. */
export type EnvSecretName = "CRAWL_RELAY_URL" | "CRAWL_RELAY_TOKEN" | "ADMIN_TOKEN";

/**
 * Variables the code reads that are not (yet) declared in `wrangler.jsonc`.
 *
 * Shop-scoped names are deliberately absent. They are composed from
 * {@link ShopDefinition.envPrefix} and {@link ShopEnvSuffix} and read through the single
 * widening boundary in `src/config.ts`, so registering a shop never means editing this union.
 */
export type UndeclaredEnvVarName =
  | "DATA_QUALITY_RETENTION_DAYS"
  | "KNOWLEDGE_CATALOG_SOURCE_MAX_CATALOG_PAGES"
  | "KNOWLEDGE_CATALOG_SOURCE_REGISTRY_JSON";

export type EnvVarName = GeneratedEnvVarName | EnvSecretName | UndeclaredEnvVarName;

/**
 * All environment variables, optional and widened to `string`.
 *
 * A finite union (rather than an index signature) is deliberate: it keeps the real `Env`
 * interface assignable to `CrawlerEnv`, which an index signature would not.
 */
export type EnvVars = { readonly [Name in EnvVarName]?: string };

/**
 * The loose environment view config/dispatch/crawl helpers accept.
 *
 * Bindings are narrowed to the members actually used so structural test doubles satisfy them;
 * the real `Env` satisfies it too.
 */
export interface CrawlerEnv extends EnvVars {
  readonly DB?: QueryableDatabase;
  /** Legacy rollout fallback; new production work uses one of the lane-specific bindings below. */
  readonly CRAWL_QUEUE?: Pick<Queue<CrawlQueueMessage>, "send">;
  readonly CRAWL_FAST_QUEUE?: Pick<Queue<CrawlQueueMessage>, "send">;
  readonly CRAWL_HEAVY_QUEUE?: Pick<Queue<CrawlQueueMessage>, "send">;
  readonly CRAWL_RELAY_QUEUE?: Pick<Queue<CrawlQueueMessage>, "send">;
  // The knowledge-catalog queue binding is declared by `KnowledgeCatalogQueueEnv` instead, so the
  // crawler vocabulary does not have to know the shape of a verification message.
  readonly BROWSER?: BrowserRun;
  readonly EVIDENCE_BUCKET?: R2Bucket;
}

// ---------------------------------------------------------------------------
// Settings (src/config.ts)
// ---------------------------------------------------------------------------

export interface CrawlerSettings {
  requestDelayMs: number;
  maxPagesPerShop: number;
  minItemRatio: number;
  minItemBaseline: number;
  healthWarningFactor: number;
  healthCriticalFactor: number;
  dispatchLeaseMinutes: number;
  productTouchIntervalMinutes: number;
  /**
   * Wall-clock budget for collecting seller pages, measured from the start of the invocation.
   *
   * Reaching it is a recorded failure that names the pages already fetched, rather than a seller
   * that keeps answering slowly until the platform kills the invocation with nothing to show.
   */
  collectionBudgetMs: number;
  /**
   * Outer wall-clock bound on one crawl invocation, measured from the same moment.
   *
   * This is the backstop for every stage, including the ones that stop gracefully on their own
   * budget. It has to stay comfortably below the platform's own limit so that exceeding it is a
   * catchable error the crawl can still record.
   */
  invocationBudgetMs: number;
  /**
   * Budget for one terminal write phase, started fresh when the outcome is being recorded.
   *
   * The work budget is spent by definition once a crawl ends, so the writes that record how it
   * ended cannot share it. A fresh short budget keeps those writes bounded without giving them a
   * reason to fail on a crawl that merely took a long time.
   */
  terminalBudgetMs: number;
  userAgent: string;
}

export interface InventoryRecheckSettings {
  enabled: boolean;
  minListingAgeHours: number;
  intervalHours: number;
  failureThreshold: number;
}

export interface MaintenanceSettings {
  crawlRunRetentionDays: number;
  dataQualityRetentionDays: number;
  priceHistoryRetentionDays: number;
  inactiveProductRetentionDays: number;
  deleteBatchSize: number;
}

// ---------------------------------------------------------------------------
// Shop definition / plugin registry
// ---------------------------------------------------------------------------

export type TransportKind = "direct" | "relay" | "browser";

/**
 * Every shop-scoped setting the platform knows how to read.
 *
 * The set is closed on purpose. A shop may not invent a setting name, and a new *kind* of shop
 * setting is a platform decision that belongs here — but the shop half of the name comes from
 * {@link ShopDefinition.envPrefix}, so adding a shop adds nothing to this union.
 */
export type ShopEnvSuffix =
  | "ENABLED"
  | "INTERVAL_MINUTES"
  | "REQUEST_DELAY_MS"
  | "MAX_PAGES"
  | "INVENTORY_RECHECK_ENABLED"
  | "INVENTORY_RECHECK_MIN_AGE_HOURS"
  | "INVENTORY_RECHECK_INTERVAL_HOURS"
  | "INVENTORY_RECHECK_FAILURE_THRESHOLD";

/** Operational metadata attached to a plugin by `defineShopPlugin`. */
export interface ShopDefinition {
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly envPrefix: string;
  readonly defaultIntervalMinutes: number;
  readonly defaultRequestDelayMs?: number;
  readonly defaultMaxPages?: number;
  readonly defaultEnabled?: boolean;
  readonly scheduleCron?: string;
  readonly transportConfigurationRequired?: boolean;
}

/** A definition as a shop writes it; `envPrefix` is always derived from the shop key. */
export type ShopDefinitionInput = Omit<ShopDefinition, "envPrefix">;

// ---------------------------------------------------------------------------
// Inventory recheck capability
// ---------------------------------------------------------------------------

/** What a shop must supply to opt into the post-crawl inventory recheck. */
export interface InventoryRecheckPolicy {
  /** Reject anything outside the shop's own detail-page URL contract. */
  isDetailUrl(value: string): boolean;

  /**
   * Maps detail-page evidence to the same canonical tri-state used by listing persistence.
   * Contradictory or non-conclusive evidence must yield `"unknown"`.
   */
  classifyPage(html: string): InventoryClassification;
}

// ---------------------------------------------------------------------------
// Discovery / page targets
// ---------------------------------------------------------------------------

/** A shop-specific crawl target. Extra fields are opaque typed context for that shop's parser. */
export interface CrawlPageObject {
  readonly url: string;
}

/** A crawl target is either a URL or a descriptor carrying one. */
export type CrawlPage = string | CrawlPageObject;

/**
 * Coverage promised by discovery.
 *
 * `complete` permits deactivation only after bounded discovery finishes without uncertainty.
 * `partial` is intentionally a subset feed. `unknown` cannot prove absence either way.
 */
export type CoverageKind = "complete" | "partial" | "unknown";

export interface DiscoveryContext {
  readonly maxPages: number;
  readonly env: CrawlerEnv;
  readonly now?: Date;
  readonly intervalMinutes?: number;
  readonly state?: ShopSyncStateRow | null;
}

/**
 * Discovery is independent from parsing. Shops describe bounded initial targets and, when
 * needed, page-to-page/category expansion. The platform validates origin, bounds and deduplicates
 * every target before fetching it.
 */
export type EmptyPageAction = "stop" | "continue";
export type ItemCountValidationMode = "coverage" | "always";

export interface DiscoveryPolicy {
  readonly emptyPage: EmptyPageAction;
  readonly itemCountValidation: ItemCountValidationMode;
  readonly extraPageBudget: number;
}

export interface DiscoveryCapability<TPage extends CrawlPage = CrawlPage> {
  readonly coverage: CoverageKind;
  readonly policy: Readonly<DiscoveryPolicy>;
  initialTargets(context: DiscoveryContext): Iterable<TPage>;
  /** `null` means this page made coverage uncertain; `[]` means no additional targets. */
  discoverTargets?(html: string, page: TPage): readonly TPage[] | null;
}

// ---------------------------------------------------------------------------
// Seller-fact contract
// ---------------------------------------------------------------------------

/** The strict seller-fact shape every shop parser must produce before catalog normalization. */
export interface SellerProduct {
  sourceId: string;
  manufacturer: string;
  rawManufacturer: string;
  model: string;
  title: string;
  rawCategory: string;
  /** Parser hint (a display label), not a category id. */
  category: string;
  conditionText: string;
  priceYen: number | null;
  stockStatus: StockStatus;
  sourceUrl: string;
  sourcePublishedAt?: string | null;
  metadata?: Record<string, unknown>;
  featureFacts?: FeatureFactInput[];
  categoryEvidence?: CategoryEvidenceInput[];
}

// ---------------------------------------------------------------------------
// Optional runtime capabilities
// ---------------------------------------------------------------------------

export interface TransportCapability {
  readonly kind: TransportKind;
}

/** Catalog normalization hints owned by one seller but interpreted by shared catalog code. */
export interface CatalogCapability {
  readonly categoryMapping?: CategoryMapping;
  readonly categoryPolicy?: CategoryPolicyInput;
}

/** Optional seller-specific detail-page evidence extraction. */
export interface DetailCategoryEvidenceCapability {
  extract(
    html: string,
    product: NormalizedCatalogProduct,
  ): CategoryEvidenceInput[] | Promise<CategoryEvidenceInput[]>;
}

/** Seller-specific diagnostic metadata. Generic orchestration treats the result as opaque. */
export interface PageDiagnosticsCapability<TPage extends CrawlPage = CrawlPage> {
  diagnosePage(html: string, page?: TPage): unknown;
}

/** Per-shop Data Quality configuration. Metric calculation remains platform-owned. */
export interface DataQualityCapability {
  readonly thresholds?: Readonly<Record<string, Partial<QualityThreshold>>>;
}

/** Capabilities exposed only after a shop is registered by the platform composition root. */
export interface ShopRuntimeCapabilities<TPage extends CrawlPage = CrawlPage> {
  readonly transport?: Readonly<TransportCapability>;
  readonly catalog?: Readonly<CatalogCapability>;
  readonly detailCategoryEvidence?: Readonly<DetailCategoryEvidenceCapability>;
  readonly inventoryRecheck?: Readonly<InventoryRecheckPolicy>;
  readonly diagnostics?: Readonly<PageDiagnosticsCapability<TPage>>;
  readonly dataQuality?: Readonly<DataQualityCapability>;
  readonly activityPolicy?: Readonly<ProductActivityPolicy>;
}

// ---------------------------------------------------------------------------
// Shop adapter contract
// ---------------------------------------------------------------------------

/**
 * Universal seller-facing contract: identity, discovery and seller-fact parsing. Optional
 * platform behavior is attached at registration through `ShopRuntimeCapabilities`.
 */
export interface ShopAdapter<TPage extends CrawlPage = CrawlPage> {
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly discovery: DiscoveryCapability<TPage>;

  /** Raw seller facts. `defineShopPlugin` validates and normalizes them before the crawler sees them. */
  parse(html: string, page?: TPage): SellerProduct[];
}

/** A registered shop after validation, frozen composition and central normalization wrapping. */
export interface ShopPlugin<TPage extends CrawlPage = CrawlPage> extends Omit<
  ShopAdapter<TPage>,
  "parse"
> {
  readonly definition: Readonly<ShopDefinition>;
  readonly capabilities: Readonly<ShopRuntimeCapabilities<TPage>>;
  parse(html: string, page?: TPage): NormalizedCatalogProduct[];
}

// ---------------------------------------------------------------------------
// HTML transport
// ---------------------------------------------------------------------------

/** robots.txt bodies keyed by base URL (`fetch.ts`) or by origin (`browser.ts`). */
export type RobotsCache = Map<string, string | null>;

export interface FetchHtmlPageOptions {
  /** Cache key and robots.txt origin; supplied from `adapter.baseUrl`. */
  baseUrl: string;
  userAgent: string;
  requestDelayMs: number;
  fetchFn?: typeof fetch;
  robotsCache?: RobotsCache;
}

export interface RelayPageOptions {
  userAgent?: string;
  requestDelayMs?: number;
}

/** Raw relay response; only the relay transport exposes this. */
export interface RelayPage {
  /** Upstream status from `x-hifiscout-upstream-status`, else the relay's own status. */
  status: number;
  contentType: string;
  body: string;
}

export interface RelayConfiguration {
  relayUrl: string;
  relayToken: string;
}

export interface RelayFetcherConfig {
  relayUrl?: string;
  relayToken?: string;
  fetchFn?: typeof fetch;
}

/** What `createTransport` returns. */
export interface HtmlTransport {
  fetchHtmlPage(url: string, options: FetchHtmlPageOptions): Promise<string>;
  close?(): Promise<void>;
  fetchPage?(url: string, options?: RelayPageOptions): Promise<RelayPage>;
}

/** The slice of the transport the category enricher needs. */
export type DetailHtmlFetcher = Pick<HtmlTransport, "fetchHtmlPage">;

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------

export interface RobotsRule {
  type: "allow" | "disallow";
  path: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
}

export interface RobotsPolicy {
  text: string | null;
  status: number;
}

// ---------------------------------------------------------------------------
// Augmented errors
// ---------------------------------------------------------------------------

export interface AugmentedCrawlError extends Error {
  status?: number;
  relayStatus?: number;
  code?: string;
  evidenceReason?: string;
}

// ---------------------------------------------------------------------------
// Queue + dispatch
// ---------------------------------------------------------------------------

export type CrawlQueueLane = "fast" | "heavy" | "relay";

export interface CrawlQueueMessage {
  shopKey: string;
  force: boolean;
  requestedAt: string;
  /** Stable logical identity for this child job. Optional only for legacy queued messages. */
  jobId?: string;
  /** Correlates all child jobs created by one scheduler invocation. */
  batchRunId?: string;
  /** Intended execution pool. Queue routing remains authoritative. */
  lane?: CrawlQueueLane;
}

export interface DueDispatchCandidate {
  adapter: ShopPlugin;
  state: ShopSyncStateRow | null;
  lastAttempt: string;
}

export type DispatchRejectionReason = "unknown_shop" | "disabled" | "configuration_missing";

export type DispatchResult =
  | { status: "queued"; queued: string[] }
  | { status: "skipped"; queued: string[] }
  | { status: "queued"; shopKey: string }
  | { status: "rejected"; reason: DispatchRejectionReason }
  | { status: "skipped"; reason: "dispatch_lease_active"; shopKey: string };

// ---------------------------------------------------------------------------
// Crawl results
// ---------------------------------------------------------------------------

export type CrawlSkipReason =
  | "disabled"
  | "configuration_missing"
  | "not_due"
  | "no_shop_due"
  | "unknown_shop"
  | "crawl_in_progress"
  | "stale_dispatch";

export interface CrawlSkippedResult {
  status: "skipped";
  reason: CrawlSkipReason;
  shopKey?: string;
  /** Queue consumers use this only for a live single-flight lease. */
  retryAfterSeconds?: number;
}

export interface CategoryEnrichmentCounters {
  detailRequests: number;
  cacheHits: number;
  enrichedCount: number;
  unresolvedCount: number;
}

export interface CrawlSuccessResult {
  status: "success";
  shopKey: string;
  crawlRunId: number;
  itemCount: number;
  pageCount: number;
  changedCount: number;
  activityCount: number;
  featureFactCount: number;
  metadataChangedCount: number;
  touchedCount: number;
  deactivatedCount: number;
  deactivateMissing: boolean;
  dataQuality: QualityEvaluation | null;
  searchProjection: { changedCount: number };
  productIdentity: IdentitySyncMetrics;
  searchEntities: ProductSearchEntitySyncResult;
  categoryEnrichment: CategoryEnrichmentCounters;
  inventoryRecheck?: InventoryRecheckResult;
}

export interface CrawlFailedResult {
  status: "failed";
  shopKey: string;
  /** Null when the failure happened before the run row itself could be created. */
  crawlRunId: number | null;
  error: string;
  dataQuality: QualityEvaluation | null;
}

export type CrawlResult = CrawlSkippedResult | CrawlSuccessResult | CrawlFailedResult;

/** Result of `enrichProductCategories`. */
export interface CategoryEnrichmentResult extends CategoryEnrichmentCounters {
  products: NormalizedCatalogProduct[];
  catalogMatches: number;
}

// ---------------------------------------------------------------------------
// Inventory recheck
// ---------------------------------------------------------------------------

/** Detail-page classification uses the same canonical tri-state as listing persistence. */
export type InventoryClassification = StockStatus;

export type InventoryRecheckOutcome =
  | "in_stock"
  | "ambiguous"
  | "missing_deactivated"
  | "missing_retry"
  | "sold_deactivated"
  | "sold_retry";

export type InventoryRecheckReason =
  | "disabled"
  | "no_candidate"
  | "invalid_detail_url"
  | "robots_disallowed"
  | "relay_error"
  | "unexpected_content_type"
  | "inventory_recheck_error"
  | `relay_http_${number}`
  | `upstream_http_${number}`
  | `unexpected_http_${number}`;

export interface InventoryRecheckResult {
  status: "skipped" | "deferred" | "checked" | "failed";
  reason?: InventoryRecheckReason;
  outcome?: InventoryRecheckOutcome;
  sourceId?: string;
  productId?: number;
  error?: string;
  failureCount?: number;
  httpStatus?: number;
}
