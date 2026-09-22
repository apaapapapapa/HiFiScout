import { applyAuctionObservation } from "./observations.js";
import { auctionComparablePriceYen } from "./prices.js";
import type { AuctionObservation, AuctionSnapshot } from "./types.js";
import type { AuctionPublicIdentity } from "./public-offer.js";
import {
  initialAuctionRuntime,
  type AuctionRuntimeState,
  type AuctionTask,
} from "./runtime-policy.js";
import { YAHOO_AUCTION_PILOT_LIMITS } from "./yahoo/policy.js";

export interface AuctionSqlUsage {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
}
export type AuctionSqlFamily =
  | "schema"
  | "control"
  | "item"
  | "live"
  | "fts"
  | "task"
  | "receipt"
  | "catalog"
  | "search"
  | "retention";
export const auctionSearchText = (value: string): string =>
  value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
export interface StoredAuction {
  snapshot: AuctionSnapshot;
  identity: AuctionPublicIdentity;
  matchUntil: number;
  fingerprint: string;
}

/** SQL cursors are exhausted synchronously before metering or any caller await. */
export class AuctionStore {
  readonly usage: Partial<Record<AuctionSqlFamily, AuctionSqlUsage>> = {};
  constructor(readonly storage: DurableObjectStorage) {
    const exists = this.sql(
      "schema",
      "SELECT name FROM sqlite_master WHERE type='table' AND name='auction_schema'",
    ).length;
    const version = exists
      ? this.sql<{ version: number }>("schema", "SELECT version FROM auction_schema WHERE id=1")[0]
          .version
      : 0;
    if (version > 1) throw new Error("auction_schema_newer_than_worker");
    if (version === 0)
      storage.transactionSync(() => {
        for (const statement of [
          "CREATE TABLE auction_runtime_state(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)",
          `CREATE TABLE auction_items(id INTEGER PRIMARY KEY, auction_id TEXT NOT NULL UNIQUE,
          source_url TEXT NOT NULL, item TEXT NOT NULL, fingerprint TEXT NOT NULL,
          manufacturer TEXT NOT NULL DEFAULT '', model TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT '',
          model_key TEXT NOT NULL DEFAULT '', catalog_id INTEGER, match_until INTEGER NOT NULL DEFAULT 0,
          identity TEXT NOT NULL DEFAULT '{"catalogProductId":null,"manufacturer":"","model":"","categoryId":""}')`,
          "CREATE INDEX auction_model ON auction_items(model_key,auction_id)",
          "CREATE INDEX auction_catalog ON auction_items(catalog_id,auction_id)",
          "CREATE INDEX auction_match_due ON auction_items(match_until,auction_id)",
          `CREATE TABLE auction_live_state(auction_id TEXT PRIMARY KEY, value TEXT NOT NULL,
          observed_at TEXT NOT NULL, state TEXT, state_at TEXT, end_at TEXT, current_price INTEGER,
          buy_price INTEGER, buy_status TEXT NOT NULL, cycle INTEGER NOT NULL,
          FOREIGN KEY(auction_id) REFERENCES auction_items(auction_id) ON DELETE CASCADE)`,
          "CREATE INDEX auction_current_price ON auction_live_state(current_price,auction_id)",
          "CREATE INDEX auction_buy_price ON auction_live_state(buy_price,auction_id)",
          "CREATE INDEX auction_end ON auction_live_state(end_at,auction_id)",
          "CREATE INDEX auction_observed ON auction_live_state(observed_at,auction_id)",
          "CREATE VIRTUAL TABLE auction_fts USING fts5(text, tokenize='trigram')",
          `CREATE TABLE auction_tasks(id TEXT PRIMARY KEY, kind TEXT NOT NULL, due INTEGER NOT NULL, value TEXT NOT NULL)`,
          "CREATE INDEX auction_task_due ON auction_tasks(kind,due,id)",
          "CREATE INDEX auction_task_exhausted ON auction_tasks(due,id)",
          "CREATE TABLE auction_page_receipts(id TEXT PRIMARY KEY, committed_at INTEGER NOT NULL, coverage TEXT NOT NULL)",
          "CREATE INDEX auction_receipt_age ON auction_page_receipts(committed_at,id)",
          "CREATE TABLE catalog_match_cache(key TEXT PRIMARY KEY, value TEXT NOT NULL, expires INTEGER NOT NULL)",
          "CREATE INDEX auction_cache_expiry ON catalog_match_cache(expires,key)",
          "CREATE TABLE auction_schema(id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL)",
          "INSERT INTO auction_schema VALUES(1,1)",
        ])
          this.sql("schema", statement);
      });
  }
  sql<T extends Record<string, SqlStorageValue> = Record<string, SqlStorageValue>>(
    family: AuctionSqlFamily,
    query: string,
    ...bindings: SqlStorageValue[]
  ): T[] {
    const cursor = this.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    const current = this.usage[family] ?? { rowsRead: 0, rowsWritten: 0, statements: 0 };
    current.rowsRead += cursor.rowsRead;
    current.rowsWritten += cursor.rowsWritten;
    current.statements++;
    this.usage[family] = current;
    return rows;
  }
  resetUsage(): void {
    for (const family of Object.keys(this.usage) as AuctionSqlFamily[]) delete this.usage[family];
  }
  runtime(now: number): AuctionRuntimeState {
    const row = this.sql<{ value: string }>(
      "control",
      "SELECT value FROM auction_runtime_state WHERE id=1",
    )[0];
    return row ? (JSON.parse(row.value) as AuctionRuntimeState) : initialAuctionRuntime(now);
  }
  saveRuntime(state: AuctionRuntimeState): void {
    this.sql(
      "control",
      `INSERT INTO auction_runtime_state(id,value) VALUES(1,?)
      ON CONFLICT(id) DO UPDATE SET value=excluded.value WHERE value IS NOT excluded.value`,
      JSON.stringify(state),
    );
  }
  item(id: string): StoredAuction | null {
    const row = this.sql<{
      item: string;
      source_url: string;
      value: string;
      identity: string;
      match_until: number;
      fingerprint: string;
    }>(
      "item",
      "SELECT i.item,i.source_url,i.identity,i.match_until,i.fingerprint,l.value FROM auction_items i JOIN auction_live_state l USING(auction_id) WHERE i.auction_id=?",
      id,
    )[0];
    if (!row) return null;
    const live = JSON.parse(row.value) as Pick<AuctionSnapshot, "stamp" | "cycle" | "live">;
    return {
      snapshot: {
        ...live,
        source: "yahoo-auctions",
        auctionId: id,
        sourceUrl: row.source_url,
        item: JSON.parse(row.item),
      },
      identity: JSON.parse(row.identity),
      matchUntil: row.match_until,
      fingerprint: row.fingerprint,
    };
  }
  /** Caller owns a short transaction containing receipt and task advancement as well. */
  apply(next: AuctionObservation, retainedCount?: number): boolean {
    const prior = this.item(next.auctionId);
    const applied = applyAuctionObservation(prior?.snapshot ?? null, next);
    if (applied.status !== "applied") return false;
    if (
      !prior &&
      (retainedCount ??
        this.sql<{ n: number }>("item", "SELECT count(*) n FROM auction_items")[0].n) >=
        YAHOO_AUCTION_PILOT_LIMITS.retainedItems
    )
      return false;
    const snapshot = applied.snapshot;
    const item = JSON.stringify(snapshot.item);
    if (!prior || JSON.stringify(prior.snapshot.item) !== item) {
      this.sql(
        "item",
        `INSERT INTO auction_items(auction_id,source_url,item,fingerprint,model_key)
        VALUES(?,?,?,?,?) ON CONFLICT(auction_id) DO UPDATE SET item=excluded.item,fingerprint=excluded.fingerprint,
        model_key=excluded.model_key,catalog_id=NULL,match_until=0`,
        next.auctionId,
        next.sourceUrl,
        item,
        item,
        auctionSearchText(snapshot.item.rawModel ?? ""),
      );
      const row = this.sql<{ id: number }>(
        "item",
        "SELECT id FROM auction_items WHERE auction_id=?",
        next.auctionId,
      )[0];
      if (prior) this.sql("fts", "DELETE FROM auction_fts WHERE rowid=?", row.id);
      this.sql(
        "fts",
        "INSERT INTO auction_fts(rowid,text) VALUES(?,?)",
        row.id,
        auctionSearchText(
          `${snapshot.item.title} ${snapshot.item.rawManufacturer ?? ""} ${snapshot.item.rawModel ?? ""}`,
        ),
      );
    }
    const { live, stamp, cycle } = snapshot;
    this.sql(
      "live",
      `INSERT INTO auction_live_state(auction_id,value,observed_at,state,state_at,end_at,current_price,buy_price,buy_status,cycle)
      VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(auction_id) DO UPDATE SET value=excluded.value,observed_at=excluded.observed_at,
      state=excluded.state,state_at=excluded.state_at,end_at=excluded.end_at,current_price=excluded.current_price,
      buy_price=excluded.buy_price,buy_status=excluded.buy_status,cycle=excluded.cycle WHERE value IS NOT excluded.value`,
      snapshot.auctionId,
      JSON.stringify({ live, stamp, cycle }),
      stamp.observedAt,
      live.sourceState?.value ?? null,
      live.sourceState?.observedAt ?? null,
      live.scheduledEndAt?.value ?? null,
      auctionComparablePriceYen(live.currentPrice?.value),
      auctionComparablePriceYen(live.buyNowPrice?.value),
      !live.buyNowPrice ? "unknown" : live.buyNowPrice.value === null ? "none" : "set",
      cycle,
    );
    return true;
  }
  task(task: AuctionTask): void {
    this.sql(
      "task",
      `INSERT INTO auction_tasks(id,kind,due,value) VALUES(?,?,?,?) ON CONFLICT(id)
      DO UPDATE SET due=excluded.due,value=excluded.value WHERE value IS NOT excluded.value`,
      task.id,
      task.kind,
      task.due,
      JSON.stringify(task),
    );
  }
  getTask(id: string): AuctionTask | null {
    const row = this.sql<{ value: string }>(
      "task",
      "SELECT value FROM auction_tasks WHERE id=?",
      id,
    )[0];
    return row ? (JSON.parse(row.value) as AuctionTask) : null;
  }
  nextTask(lastKind: string, now: number): AuctionTask | null {
    // Alternate ready classes; future work cannot starve an already due class.
    const rows = ["discover", "confirm"]
      .flatMap((kind) =>
        this.sql<{ value: string }>(
          "task",
          "SELECT value FROM auction_tasks WHERE kind=? ORDER BY due,id LIMIT 1",
          kind,
        ),
      )
      .map((row) => JSON.parse(row.value) as AuctionTask);
    return (
      rows
        .filter((row) => row.due <= now)
        .sort(
          (a, b) => Number(a.kind === lastKind) - Number(b.kind === lastKind) || a.due - b.due,
        )[0] ??
      rows.sort((a, b) => a.due - b.due)[0] ??
      null
    );
  }
  receipt(id: string): boolean {
    return this.sql("receipt", "SELECT id FROM auction_page_receipts WHERE id=?", id).length > 0;
  }
  commitReceipt(id: string, now: number, coverage: "partial" | "unknown"): void {
    this.sql("receipt", "INSERT INTO auction_page_receipts VALUES(?,?,?)", id, now, coverage);
  }
  retain(now: number): void {
    this.storage.transactionSync(() => {
      const cutoff = new Date(now - 7 * 86_400_000).toISOString();
      const rows = this.sql<{ id: number; auction_id: string }>(
        "retention",
        `SELECT i.id,i.auction_id FROM auction_live_state l JOIN auction_items i USING(auction_id)
         WHERE l.observed_at < ? ORDER BY l.observed_at LIMIT 20`,
        cutoff,
      );
      for (const row of rows) {
        this.sql("retention", "DELETE FROM auction_fts WHERE rowid=?", row.id);
        this.sql("retention", "DELETE FROM auction_live_state WHERE auction_id=?", row.auction_id);
        this.sql("retention", "DELETE FROM auction_items WHERE id=?", row.id);
        this.sql("retention", "DELETE FROM auction_tasks WHERE id=?", `confirm:${row.auction_id}`);
      }
      this.sql(
        "retention",
        "DELETE FROM auction_page_receipts WHERE id IN (SELECT id FROM auction_page_receipts WHERE committed_at<? ORDER BY committed_at LIMIT 20)",
        now - 7 * 86_400_000,
      );
      this.sql(
        "retention",
        "DELETE FROM catalog_match_cache WHERE key IN (SELECT key FROM catalog_match_cache WHERE expires<? LIMIT 20)",
        now - 86_400_000,
      );
    });
  }
}
