import { resolveManufacturer } from "../catalog/manufacturer-resolver.js";
import { resolveModel } from "../catalog/model-resolver.js";
import { resolveProductIdentity } from "../catalog/product-identity.js";
import { collectListingCategoryEvidence } from "../catalog/category-evidence.js";
import { classifyCategoryEvidence } from "../catalog/category-classifier.js";
import { RESOLUTION_VERSIONS } from "../catalog/resolution-versions.js";
import type { IdentityCandidateInput } from "../catalog/types.js";
import type { AuctionItemFacts } from "./types.js";
import type { AuctionPublicIdentity } from "./public-offer.js";
import { AuctionStore, auctionSearchText } from "./storage.js";
import { emptyAuctionCharge, reserveAuctionBudget } from "./runtime-policy.js";

export const AUCTION_CATALOG_RULE = JSON.stringify({ ...RESOLUTION_VERSIONS, auction: 1 });
export const AUCTION_CATALOG_TTL = 15 * 60_000;
/** Public SQL joins must additionally compare the listing revision to this cached revision. */
export function currentAuctionIdentity(
  identity: AuctionPublicIdentity,
  revision: string,
  cache: { value: string; expires: number } | null,
  now: number,
): AuctionPublicIdentity {
  const entry = cache ? (JSON.parse(cache.value) as Partial<AuctionCatalogEntry>) : null;
  if (
    cache &&
    cache.expires > now &&
    entry?.rule === AUCTION_CATALOG_RULE &&
    entry.revision === revision
  )
    return identity;
  return { catalogProductId: null, manufacturer: "", model: "", categoryId: "" };
}
export interface AuctionCatalogInput {
  key: string;
  manufacturer: string;
  model: string;
}
export interface AuctionCatalogEntry {
  input: AuctionCatalogInput;
  manufacturerId: string;
  manufacturerName: string;
  model: string;
  candidates: (IdentityCandidateInput & { canonicalName: string })[];
  revision: string;
  rule: string;
}
export interface AuctionCatalogReader {
  read(inputs: readonly AuctionCatalogInput[]): Promise<AuctionCatalogEntry[]>;
}
/** Shared candidate key only; title, subject, edition and unit remain on the individual listing. */
export function auctionCatalogInput(item: AuctionItemFacts): AuctionCatalogInput {
  const manufacturer = resolveManufacturer({
    rawManufacturer: item.rawManufacturer ?? "",
    title: item.title,
  });
  const model = resolveModel({
    rawManufacturer: item.rawManufacturer ?? "",
    rawModel: item.rawModel ?? "",
    manufacturerId: manufacturer.canonicalManufacturerId,
    title: item.title,
  });
  const input = {
    manufacturer: item.rawManufacturer || manufacturer.displayName,
    model: item.rawModel || model.model,
  };
  return {
    key: JSON.stringify([auctionSearchText(input.manufacturer), auctionSearchText(input.model)]),
    ...input,
  };
}
export function auctionCatalogIdentity(
  item: AuctionItemFacts,
  entry: AuctionCatalogEntry,
): AuctionPublicIdentity {
  const manufacturer = entry.manufacturerId;
  const model = resolveModel({
    rawManufacturer: item.rawManufacturer ?? "",
    rawModel: item.rawModel ?? "",
    manufacturerId: manufacturer,
    title: item.title,
  });
  const fallback = {
    catalogProductId: null,
    manufacturer: entry.manufacturerName,
    model: model.status === "resolved" ? model.model : "",
    categoryId: "",
  };
  if (
    entry.rule !== AUCTION_CATALOG_RULE ||
    !manufacturer ||
    item.saleSubject !== "main_unit" ||
    item.saleUnit === "set"
  )
    return fallback;
  const resolved = resolveProductIdentity(
    {
      title: item.title,
      rawModel: item.rawModel ?? "",
      manufacturerId: manufacturer,
      model: model.model,
      modelResolutionStatus: model.status,
      primaryCategoryId: classifyCategoryEvidence(
        collectListingCategoryEvidence({
          title: item.title,
          rawCategory: item.rawCategory,
          manufacturer: entry.manufacturerName,
          hintedCategory: item.categoryHint,
          categoryPolicy: { sellerCategory: { default: "corroborative" } },
        }).evidence,
      ).primaryCategoryId,
    },
    entry.candidates,
  );
  const candidate = entry.candidates.find((row) => row.id === resolved.catalogProductId);
  if (resolved.status !== "matched" || !candidate) return fallback;
  return {
    ...fallback,
    catalogProductId: candidate.id,
    model: candidate.canonicalModel ?? model.model,
    categoryId: candidate.categoryIds?.[0] ?? "",
  };
}

/** Periodic bounded key snapshots detect additions/deletions/merges without a second catalog. */
export class AuctionCatalogMaintenance {
  constructor(
    readonly store: AuctionStore,
    readonly reader: AuctionCatalogReader,
  ) {}
  nextDue(now: number): number | null {
    const scheduled = this.store.sql<{ next_due: number }>(
      "catalog",
      "SELECT next_due FROM auction_catalog_schedule WHERE id=1",
    )[0];
    if (scheduled) return scheduled.next_due;
    return this.store.sql(
      "catalog",
      "SELECT auction_id FROM auction_items WHERE match_key='' LIMIT 1",
    ).length
      ? now
      : null;
  }
  private schedule(next: number, error: string | null): void {
    this.store.sql(
      "catalog",
      `INSERT INTO auction_catalog_schedule VALUES(1,?,?) ON CONFLICT(id)
      DO UPDATE SET next_due=excluded.next_due,error=excluded.error WHERE next_due IS NOT excluded.next_due OR error IS NOT excluded.error`,
      next,
      error,
    );
  }
  async run(now: number, beforeRead?: () => Promise<void>): Promise<void> {
    const state = this.store.runtime(now);
    const reserved = reserveAuctionBudget(
      state,
      { ...emptyAuctionCharge(), reads: 5000, writes: 500, durationGbSeconds: 4 },
      now,
    );
    if (!reserved) {
      this.schedule(
        (Math.max(state.utcDay, Math.floor(now / 86_400_000)) + 1) * 86_400_000,
        "budget_exhausted",
      );
      return;
    }
    this.store.saveRuntime(reserved);
    // The restart checkpoint precedes I/O; a crashed lookup never creates a busy retry loop.
    this.schedule(now + 5 * 60_000, null);
    await beforeRead?.();
    const current = () => {
      const latest = this.store.runtime(now);
      return latest.generation === state.generation && !latest.paused;
    };
    try {
      await this.refresh(now, current);
      if (!current()) return;
      const work =
        this.store.sql(
          "catalog",
          `SELECT i.auction_id FROM auction_items i WHERE match_key='' LIMIT 1`,
        ).length ||
        this.store.sql(
          "catalog",
          `SELECT r.key FROM auction_catalog_replays r JOIN catalog_match_cache c USING(key) WHERE c.expires>? AND EXISTS(SELECT 1 FROM auction_items i WHERE i.match_key=c.key) LIMIT 1`,
          now,
        ).length;
      const expiry = this.store.sql<{ expires: number }>(
        "catalog",
        "SELECT c.expires FROM catalog_match_cache c WHERE EXISTS(SELECT 1 FROM auction_items i WHERE i.match_key=c.key) ORDER BY c.expires,c.key LIMIT 1",
      )[0]?.expires;
      if (!work && expiry === undefined) {
        this.store.sql("catalog", "DELETE FROM auction_catalog_schedule WHERE id=1");
        return;
      }
      this.schedule(
        work ? now + 60_000 : Math.max(now + 60_000, (expiry ?? now + 15 * 60_000) - 60_000),
        null,
      );
    } catch {
      if (current()) this.schedule(now + 30 * 60_000, "catalog_unavailable");
    }
  }
  private setIdentity(
    row: { auction_id: string; item: string; fingerprint: string },
    entry: AuctionCatalogEntry,
  ): void {
    const item = JSON.parse(row.item) as AuctionItemFacts;
    const identity = auctionCatalogIdentity(item, entry);
    this.store.sql(
      "catalog",
      `UPDATE auction_items SET identity=?,catalog_id=?,manufacturer=?,model=?,model_key=?,category=?,match_revision=?
      WHERE auction_id=? AND fingerprint=? AND (match_revision IS NOT ? OR identity IS NOT ?)`,
      JSON.stringify(identity),
      identity.catalogProductId,
      auctionSearchText(identity.manufacturer),
      identity.model,
      auctionSearchText(item.rawModel || identity.model),
      identity.categoryId,
      entry.revision,
      row.auction_id,
      row.fingerprint,
      entry.revision,
      JSON.stringify(identity),
    );
  }
  async refresh(now: number, canCommit = () => true): Promise<void> {
    // Register only changed listing inputs. Price-only observations leave these columns untouched.
    this.store.storage.transactionSync(() => {
      const rows = this.store.sql<{ auction_id: string; item: string; fingerprint: string }>(
        "catalog",
        "SELECT auction_id,item,fingerprint FROM auction_items WHERE match_key='' ORDER BY auction_id LIMIT 20",
      );
      for (const row of rows) {
        const input = auctionCatalogInput(JSON.parse(row.item) as AuctionItemFacts);
        this.store.sql(
          "catalog",
          "UPDATE auction_items SET match_key=? WHERE auction_id=?",
          input.key,
          row.auction_id,
        );
        const exists = this.store.sql<{ value: string; expires: number }>(
          "catalog",
          "SELECT value,expires FROM catalog_match_cache WHERE key=?",
          input.key,
        )[0];
        if (!exists)
          this.store.sql(
            "catalog",
            "INSERT INTO catalog_match_cache VALUES(?,?,0)",
            input.key,
            JSON.stringify({ input }),
          );
        const entry = exists ? (JSON.parse(exists.value) as AuctionCatalogEntry) : null;
        if (entry?.rule === AUCTION_CATALOG_RULE && exists!.expires > now) {
          this.setIdentity(row, entry);
          continue;
        }
        this.store.sql(
          "catalog",
          "INSERT INTO auction_catalog_replays VALUES(?,'') ON CONFLICT(key) DO UPDATE SET cursor=''",
          input.key,
        );
      }
    });
    const due = this.store.sql<{ key: string; value: string }>(
      "catalog",
      "SELECT c.key,c.value FROM catalog_match_cache c WHERE c.expires<=? AND EXISTS(SELECT 1 FROM auction_items i WHERE i.match_key=c.key) ORDER BY c.expires,c.key LIMIT 20",
      now + 60_000,
    );
    if (due.length) {
      const inputs = due.map(
        (row) => (JSON.parse(row.value) as { input: AuctionCatalogInput }).input,
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      const entries = await Promise.race([
        this.reader.read(inputs),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error("catalog_timeout")), 15_000);
        }),
      ]).finally(() => clearTimeout(timer));
      if (!canCommit()) return;
      // No SQL cursor or transaction crosses the D1 await. A stale/missing key is never certified.
      this.store.storage.transactionSync(() => {
        for (const row of due) {
          const entry = entries.find((candidate) => candidate.input.key === row.key);
          if (!entry || entry.rule !== AUCTION_CATALOG_RULE) {
            // Negative retry snapshot prevents one failed key starving all following keys.
            const failed = {
              input: inputs.find((input) => input.key === row.key)!,
              manufacturerId: "",
              manufacturerName: "",
              model: "",
              candidates: [],
              revision: "unavailable",
              rule: AUCTION_CATALOG_RULE,
            };
            this.store.sql(
              "catalog",
              "UPDATE catalog_match_cache SET value=?,expires=? WHERE key=? AND value=?",
              JSON.stringify(failed),
              now + AUCTION_CATALOG_TTL,
              row.key,
              row.value,
            );
            this.store.sql(
              "catalog",
              "INSERT INTO auction_catalog_replays VALUES(?,'') ON CONFLICT(key) DO UPDATE SET cursor=''",
              row.key,
            );
            continue;
          }
          const previous = JSON.parse(row.value) as Partial<AuctionCatalogEntry>;
          this.store.sql(
            "catalog",
            "UPDATE catalog_match_cache SET value=?,expires=? WHERE key=? AND value=?",
            JSON.stringify(entry),
            now + AUCTION_CATALOG_TTL,
            row.key,
            row.value,
          );
          if (previous.revision !== entry.revision || previous.rule !== entry.rule)
            this.store.sql(
              "catalog",
              "INSERT INTO auction_catalog_replays VALUES(?,'') ON CONFLICT(key) DO UPDATE SET cursor=''",
              row.key,
            );
        }
      });
    }
    // One durable affected-key cursor per turn. No periodic inventory sweep or per-price D1 query.
    const pending = this.store.sql<{ key: string; cursor: string }>(
      "catalog",
      "SELECT r.key,r.cursor FROM auction_catalog_replays r JOIN catalog_match_cache c USING(key) WHERE c.expires>? AND EXISTS(SELECT 1 FROM auction_items i WHERE i.match_key=c.key) ORDER BY r.rowid LIMIT 1",
      now,
    )[0];
    if (!pending) return;
    const cache = this.store.sql<{ value: string; expires: number }>(
      "catalog",
      "SELECT value,expires FROM catalog_match_cache WHERE key=?",
      pending.key,
    )[0];
    if (!cache || cache.expires <= now) return;
    const entry = JSON.parse(cache.value) as AuctionCatalogEntry;
    if (entry.rule !== AUCTION_CATALOG_RULE) return;
    this.store.storage.transactionSync(() => {
      const rows = this.store.sql<{ auction_id: string; item: string; fingerprint: string }>(
        "catalog",
        "SELECT auction_id,item,fingerprint FROM auction_items WHERE match_key=? AND auction_id>? ORDER BY auction_id LIMIT 20",
        pending.key,
        pending.cursor,
      );
      for (const row of rows) this.setIdentity(row, entry);
      if (rows.length < 20)
        this.store.sql("catalog", "DELETE FROM auction_catalog_replays WHERE key=?", pending.key);
      else
        this.store.sql(
          "catalog",
          "UPDATE auction_catalog_replays SET cursor=? WHERE key=?",
          rows[rows.length - 1].auction_id,
          pending.key,
        );
    });
  }
}
