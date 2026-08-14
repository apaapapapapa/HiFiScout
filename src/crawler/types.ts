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
  KnowledgeSourceCandidate,
  NormalizedCatalogProduct,
  ShopParsedProduct,
} from "../catalog/types.js";
import type {
  IdentitySyncMetrics,
  KnowledgeCatalogJobType,
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
  | "KNOWLEDGE_CATALOG_QUEUE"
  | "API_RATE_LIMITER"
  | "BROWSER"
  | "ASSETS";

/** Every `vars` entry declared in `wrangler.jsonc`, taken straight from the generated `Env`. */
export type GeneratedEnvVarName = Exclude<keyof Env, EnvBindingName>;

/** Wrangler secrets: real at runtime, absent from the generated `Env`. */
export type EnvSecretName = "CRAWL_RELAY_URL" | "CRAWL_RELAY_TOKEN" | "ADMIN_TOKEN";

/**
 * Variables the code reads that are not (yet) declared in `wrangler.jsonc`.
 * Adding a shop means adding its four env names here as well.
 */
export type UndeclaredEnvVarName =
  | "UAUDIO_ENABLED"
  | "UAUDIO_INTERVAL_MINUTES"
  | "UAUDIO_REQUEST_DELAY_MS"
  | "UAUDIO_MAX_PAGES"
  | "FORMUSIC_MAX_PAGES"
  | "IPPINKAN_MAX_PAGES"
  | "AUDIOUNION_MAX_PAGES"
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
  readonly CRAWL_QUEUE?: Pick<Queue<CrawlQueueMessage>, "send">;
  readonly KNOWLEDGE_CATALOG_QUEUE?: Pick<
    Queue<KnowledgeCatalogQueueMessage>,
    "send" | "sendBatch"
  >;
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

/** Operational metadata attached to a plugin by `defineShopPlugin`. */
export interface ShopDefinition {
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly intervalEnv: EnvVarName;
  readonly enabledEnv: EnvVarName;
  readonly requestDelayEnv: EnvVarName;
  readonly defaultIntervalMinutes: number;
  readonly defaultRequestDelayMs?: number;
  readonly maxPagesEnv?: EnvVarName;
  readonly defaultMaxPages?: number;

  /**
   * Cron expression owning this shop's dispatch.
   *
   * A shop that declares one is dispatched by that trigger alone and is skipped by the shared
   * "due shops" sweep, which keeps a busy shop off the general schedule. The expression must
   * also appear in `wrangler.jsonc` `triggers.crons` — `test/schedule.test.ts` asserts that.
   */
  readonly scheduleCron?: string;

  /**
   * Missing transport configuration is a *health* problem for this shop rather than something
   * its persisted sync state will report after a failed run.
   *
   * Only set it for shops whose transport secrets are provisioned out of band, where a gap
   * would otherwise stay invisible until the next scheduled crawl.
   */
  readonly transportConfigurationRequired?: boolean;
}

// ---------------------------------------------------------------------------
// Inventory recheck capability
// ---------------------------------------------------------------------------

/**
 * What a shop must supply to opt into the post-crawl inventory recheck.
 *
 * The recheck loop itself — candidate selection, attempt marking, relay fetch, HTTP-status
 * handling, failure counting and deactivation — is shop-agnostic and lives in
 * `inventory-recheck.ts`. Only these settings names and two predicates are not.
 */
export interface InventoryRecheckPolicy {
  readonly enabledEnv: EnvVarName;
  readonly minListingAgeHoursEnv: EnvVarName;
  readonly intervalHoursEnv: EnvVarName;
  readonly failureThresholdEnv: EnvVarName;

  /**
   * Guard for the stored `source_url` before it is re-fetched. Must reject anything outside the
   * shop's own detail pages, including redirects to other hosts, ports or query strings.
   */
  isDetailUrl(value: string): boolean;

  /** Reads availability from a detail page. Contradictory evidence must yield `"ambiguous"`. */
  classifyPage(html: string): InventoryClassification;
}

// ---------------------------------------------------------------------------
// Page queue
// ---------------------------------------------------------------------------

/**
 * A shop-specific page descriptor. Every queued page carries a `url` (`shimamusen`, `fujiya`
 * and `u-audio` all attach one alongside their extra keys), so `pageUrl()` returns `string`;
 * adapters declare their own narrower descriptor and pass it as the `TPage` argument of
 * `ShopAdapter`.
 */
export interface CrawlPageObject {
  readonly url: string;
}

/** An entry of the crawl page queue: a bare URL or a descriptor carrying one. */
export type CrawlPage = string | CrawlPageObject;

/** Third argument of `adapter.pageUrls`; only `hifido` reads `now`/`intervalMinutes`. */
export interface PageUrlsContext {
  now?: Date;
  intervalMinutes?: number;
  state?: ShopSyncStateRow | null;
}

// ---------------------------------------------------------------------------
// Shop adapter contract
// ---------------------------------------------------------------------------

/**
 * A shop adapter.
 *
 * `key`, `name`, `baseUrl`, `pageUrls` and `parse` are the only universal members
 * (asserted by `test/shop-contract.test.ts`); every other member is opt-in and appears on
 * one to four of the seven adapters.
 *
 * `pageUrls`, `parse` and `discoverPageUrls` are declared as methods on purpose: method
 * parameter bivariance is what lets an adapter narrowed to its own page descriptor
 * (`ShopAdapter<FujiyaPage>`) be stored in a `ShopAdapter<CrawlPage>` registry.
 *
 * `this` inside an adapter's methods is the *plugin*, not the raw adapter: `defineShopPlugin`
 * re-binds `parse` with `parse.apply(plugin, args)`.
 */
export interface ShopAdapter<TPage extends CrawlPage = CrawlPage> {
  readonly key: string;
  readonly name: string;
  readonly baseUrl: string;

  /** Generator; all three arguments are optional because call sites pass 0-3 of them. */
  pageUrls(maxPages?: number, env?: CrawlerEnv, context?: PageUrlsContext): Iterable<TPage>;

  /** Raw parse output. `defineShopPlugin` wraps this so the crawler never sees it directly. */
  parse(html: string, page?: TPage): ShopParsedProduct[];

  /** Defaults to `"direct"` when absent. */
  readonly transport?: TransportKind;
  /** Declared by `audiounion` only; the effective delay comes from `getShopRequestDelayMs`. */
  readonly requestDelayMs?: number;
  readonly categoryMapping?: CategoryMapping;
  readonly categoryPolicy?: CategoryPolicyInput;
  /** The shop's feeds are a subset of its inventory, so missing products are never deactivated. */
  readonly partialCoverage?: boolean;
  readonly guardItemCount?: boolean;
  readonly continueOnEmpty?: boolean;
  readonly dynamicPagination?: boolean;
  readonly extraPageAllowance?: number;

  /**
   * `TPage[]` = more pages, `[]` = nothing more to crawl, `null` = coverage UNKNOWN
   * (which suppresses deactivation). Never `undefined`.
   */
  discoverPageUrls?(html: string, page: TPage): TPage[] | null;

  extractDetailCategoryEvidence?(
    html: string,
    product: NormalizedCatalogProduct,
  ): CategoryEvidenceInput[] | Promise<CategoryEvidenceInput[]>;

  /**
   * Optional per-page diagnostic snapshot for shops whose HTML needs explaining when a crawl
   * looks wrong. The crawler keeps the last non-null value and appends it to the crawl-run
   * message; it never inspects the contents, so the shape is the adapter's business.
   */
  diagnosePage?(html: string, page?: TPage): unknown;

  /** Opt-in single-listing inventory recheck, run after this shop's crawl succeeds. */
  readonly inventoryRecheck?: InventoryRecheckPolicy;

  /** Not implemented by any current adapter, but part of the contract `run`/`dispatch` read. */
  isConfigured?(env: CrawlerEnv): boolean;

  /** Per-shop data-quality threshold overrides; keys are `DEFAULT_QUALITY_THRESHOLDS` keys. */
  readonly qualityThresholds?: Readonly<Record<string, Partial<QualityThreshold>>>;

  /** Present only after `defineShopPlugin`; see `ShopPlugin`. */
  readonly definition?: Readonly<ShopDefinition>;
}

/**
 * A registered shop: the adapter plus its frozen definition, with `parse` replaced by the
 * normalizing wrapper. This is what `SHOP_PLUGINS` holds and what the crawler consumes.
 */
export interface ShopPlugin<TPage extends CrawlPage = CrawlPage> extends Omit<
  ShopAdapter<TPage>,
  "parse" | "definition"
> {
  readonly definition: Readonly<ShopDefinition>;
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

/**
 * What `createTransport` returns. `close` and `fetchPage` are optional: the direct and
 * browser transports have no `fetchPage`, and tests substitute a bare `{ fetchHtmlPage }`.
 */
export interface HtmlTransport {
  fetchHtmlPage(url: string, options: FetchHtmlPageOptions): Promise<string>;
  close?(): Promise<void>;
  /** Relay only. Returns the status instead of throwing on a non-2xx upstream response. */
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

/**
 * `new Error()` values the crawler decorates with extra properties that consumers branch on.
 * Build them with `Object.assign(new Error(msg), { status })` rather than a subclass, which
 * is what the current runtime does.
 */
export interface AugmentedCrawlError extends Error {
  /** Upstream HTTP status (`fetch.ts`, `relay.ts`, `browser.ts`). */
  status?: number;
  /** Relay-hop HTTP status, distinct from the upstream one. */
  relayStatus?: number;
  /** Currently only `"robots_disallowed"`. */
  code?: string;
  /** Evidence reason attached by `run.ts` and read back in its catch block. */
  evidenceReason?: string;
}

// ---------------------------------------------------------------------------
// Queue + dispatch
// ---------------------------------------------------------------------------

export interface CrawlQueueMessage {
  shopKey: string;
  force: boolean;
  requestedAt: string;
}

/** Which dispatcher enqueued a knowledge-catalog verification run. */
export type KnowledgeCatalogDispatchMode = "daily_candidates" | "monthly_recheck";

/**
 * Body of a `KNOWLEDGE_CATALOG_QUEUE` message. `hostname`/`target` are absent on the
 * `"finalize"` message, which is sent on its own with a delay after the target batch.
 */
export interface KnowledgeCatalogQueueMessage {
  jobId: number;
  runId: number;
  jobType: KnowledgeCatalogJobType;
  mode: KnowledgeCatalogDispatchMode;
  preferRetries: boolean;
  verifierVersion: number;
  hostname?: string;
  target?: KnowledgeSourceCandidate;
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
  | "shop_definition_missing"
  | "disabled"
  | "configuration_missing"
  | "not_due"
  | "no_shop_due"
  | "unknown_shop";

export interface CrawlSkippedResult {
  status: "skipped";
  reason: CrawlSkipReason;
  /** Absent on the `no_shop_due` result produced by `crawlNextDueShop`. */
  shopKey?: string;
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
  categoryEnrichment: CategoryEnrichmentCounters;
  /** Appended by `consumeCrawlMessage` for shops that declare an `inventoryRecheck` policy. */
  inventoryRecheck?: InventoryRecheckResult;
}

export interface CrawlFailedResult {
  status: "failed";
  shopKey: string;
  crawlRunId: number;
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

export type InventoryClassification = "in_stock" | "sold_out" | "ambiguous";

export type InventoryRecheckOutcome =
  | "in_stock"
  | "ambiguous"
  | "missing_deactivated"
  | "missing_retry"
  | "sold_deactivated"
  | "sold_retry";

/**
 * `reason` is partly templated (`relay_http_404`, `upstream_http_500`, ...), so the union
 * keeps a template-literal arm rather than pretending it is closed.
 */
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
  /** `"failed"` only: the caught error message, truncated to 200 characters. */
  error?: string;
  /** `"checked"` only, on the unavailable branches: consecutive unavailable observations. */
  failureCount?: number;
  /** `"checked"` only, on the 404/410 and sold-out branches. */
  httpStatus?: number;
}
