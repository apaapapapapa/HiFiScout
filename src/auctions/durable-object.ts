import { DurableObject } from "cloudflare:workers";
import { isRecord } from "../types.js";
import { emptyAuctionCharge, reserveAuctionBudget } from "./runtime-policy.js";
import { AuctionStore } from "./storage.js";
import { AuctionScheduler } from "./scheduler.js";
import { AuctionCatalogMaintenance } from "./catalog.js";
import { readAuctionCatalog } from "../db/auction-catalog-repository.js";
import { searchAuctions } from "./search.js";
import { AuctionQueryError, parseAuctionQuery } from "../api/auction-query.js";
import { yahooAuctionTransport } from "./yahoo/acquisition.js";
import { yahooAuctionHtmlSource } from "./yahoo/parser.js";
import {
  yahooAuctionAccess,
  YAHOO_AUCTION_PILOT_LIMITS,
  YAHOO_AUCTION_CATEGORIES,
} from "./yahoo/policy.js";

/** One stable namespace/name. No method exposes fixture ingestion or arbitrary SQL/URLs. */
export class YahooAuctions extends DurableObject<Env> {
  private engine() {
    const store = new AuctionStore(this.ctx.storage);
    return {
      store,
      scheduler: new AuctionScheduler(
        store,
        yahooAuctionTransport,
        yahooAuctionHtmlSource,
        () => yahooAuctionAccess(this.env).collect,
        Date.now,
        new AuctionCatalogMaintenance(store, {
          read: (inputs) => readAuctionCatalog(this.env.DB, inputs),
        }),
      ),
    };
  }
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/search" && !yahooAuctionAccess(this.env).search)
      return Response.json(
        { error: "auction_disabled" },
        { status: 404, headers: { "cache-control": "no-store" } },
      );
    const { store, scheduler } = this.engine();
    try {
      if (url.pathname === "/search" && request.method === "GET") {
        try {
          parseAuctionQuery(url);
        } catch (error) {
          if (error instanceof AuctionQueryError)
            return Response.json({ error: error.message }, { status: 400 });
          throw error;
        }
        if (store.runtime(Date.now()).publicPaused)
          return Response.json({ error: "auction_paused" }, { status: 503 });
        if (!this.reserve(store, 15_100, 20, false, true))
          return Response.json({ error: "auction_budget_exhausted" }, { status: 503 });
        const body = JSON.stringify(searchAuctions(store, url, Date.now()));
        if (new TextEncoder().encode(body).length > 96 * 1024)
          return Response.json({ error: "auction_response_limit" }, { status: 503 });
        return new Response(body, {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
          },
        });
      }
      if (url.pathname === "/admin/control" && request.method === "POST") {
        const body: unknown = await request.json();
        if (
          !isRecord(body) ||
          !["pause", "resume", "wake", "public_pause", "public_resume", "retry_failed"].includes(
            String(body.action),
          ) ||
          (body.categories !== undefined &&
            (!Array.isArray(body.categories) ||
              body.categories.some((id) => typeof id !== "string")))
        )
          return Response.json({ error: "invalid_auction_control" }, { status: 400 });
        if (
          !this.reserve(store, 100, 50, body.action === "pause" || body.action === "public_pause")
        )
          return Response.json({ error: "auction_budget_exhausted" }, { status: 503 });
        await scheduler.control(
          body.action as
            | "pause"
            | "resume"
            | "wake"
            | "public_pause"
            | "public_resume"
            | "retry_failed",
          body.categories as string[] | undefined,
        );
        return Response.json({ ok: true });
      }
      if (url.pathname === "/admin/status" && request.method === "GET") {
        if (!this.reserve(store, 6_100, 100))
          return Response.json({ error: "auction_budget_exhausted" }, { status: 503 });
        const { robots: _robots, ...state } = store.runtime(Date.now());
        return Response.json({
          state,
          access: yahooAuctionAccess(this.env),
          limits: YAHOO_AUCTION_PILOT_LIMITS,
          categories: YAHOO_AUCTION_CATEGORIES,
          nextAlarm: await this.ctx.storage.getAlarm(),
          retainedItems: store.sql<{ n: number }>(
            "control",
            "SELECT count(*) n FROM auction_items",
          )[0].n,
          pendingTasks: store.sql<{ n: number }>(
            "control",
            "SELECT count(*) n FROM auction_tasks",
          )[0].n,
          exhaustedTasks: store.sql<{ n: number }>(
            "control",
            "SELECT count(*) n FROM auction_tasks WHERE due=?",
            Number.MAX_SAFE_INTEGER,
          )[0].n,
          productionUsage: null,
          reservationKind: "conservative_upper_bound",
        });
      }
      return new Response("not found", { status: 404 });
    } finally {
      this.logUsage(store, "request");
    }
  }
  async alarm(): Promise<void> {
    const { store, scheduler } = this.engine();
    try {
      if (this.reserve(store, 50, 20, true)) await scheduler.alarm();
      else await scheduler.deferForBudget();
    } finally {
      this.logUsage(store, "alarm");
    }
  }
  private reserve(
    store: AuctionStore,
    reads: number,
    writes: number,
    recovery = false,
    publicRead = false,
  ): boolean {
    const next = reserveAuctionBudget(
      store.runtime(Date.now()),
      {
        ...emptyAuctionCharge(),
        requests: 1,
        publicRequests: publicRead ? 1 : 0,
        reads,
        writes,
        durationGbSeconds: 0.25,
      },
      Date.now(),
      recovery,
    );
    if (!next || this.ctx.storage.sql.databaseSize >= YAHOO_AUCTION_PILOT_LIMITS.storedBytes)
      return false;
    store.saveRuntime(next);
    return true;
  }
  private logUsage(store: AuctionStore, event: string): void {
    console.log(
      JSON.stringify({
        event: "auction_sql_usage",
        operation: event,
        families: store.usage,
        workerVersionId: this.env.CF_VERSION_METADATA?.id ?? null,
        cpuMs: null,
        billedDurationGbSeconds: null,
        storageBytes: this.ctx.storage.sql.databaseSize,
      }),
    );
  }
}
