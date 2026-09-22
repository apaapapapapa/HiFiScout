import { DurableObject } from "cloudflare:workers";
import { parseAuctionAdminCommand } from "../api/admin-auction-contracts.js";
import { readJsonBody, REQUEST_BODY_TOO_LARGE } from "../http/request.js";
import { auctionAdminStatus } from "./status.js";
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
  yahooAuctionCategory,
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
        const body = await readJsonBody(request, 1024);
        if (body === REQUEST_BODY_TOO_LARGE)
          return Response.json({ error: "request_body_too_large" }, { status: 413 });
        const command = parseAuctionAdminCommand(body);
        if (
          !command ||
          command.action === "status" ||
          command.categories?.some((id) => !yahooAuctionCategory(id))
        )
          return Response.json({ error: "invalid_auction_control" }, { status: 400 });
        if (
          command.action === "clear_halt" &&
          (!yahooAuctionAccess(this.env).collect || !store.runtime(Date.now()).paused)
        )
          return Response.json({ error: "auction_halt_review_required" }, { status: 409 });
        if (
          !this.reserve(
            store,
            100,
            50,
            command.action === "pause" || command.action === "public_pause",
            false,
            4,
          )
        )
          return Response.json({ error: "auction_budget_exhausted" }, { status: 503 });
        await scheduler.control(command.action, command.categories);
        return Response.json({ ok: true });
      }
      if (url.pathname === "/admin/status" && request.method === "GET") {
        if (!this.reserve(store, 10_100, 100, false, false, 1))
          return Response.json({ error: "auction_budget_exhausted" }, { status: 503 });
        return Response.json(await auctionAdminStatus(store, this.env, Date.now()));
      }

      return new Response("not found", { status: 404 });
    } finally {
      this.logUsage(store, "request");
    }
  }
  async alarm(): Promise<void> {
    const { store, scheduler } = this.engine();
    try {
      if (this.reserve(store, 50, 20, true, false, 6)) await scheduler.alarm();
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
    alarmOperations = 0,
  ): boolean {
    const next = reserveAuctionBudget(
      store.runtime(Date.now()),
      {
        ...emptyAuctionCharge(),
        requests: 1,
        publicRequests: publicRead ? 1 : 0,
        alarmOperations,
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
        alarmOperations: store.alarmOperations,
        kvOperations: { get: 0, put: 0, delete: 0 },
        observationKind: "local_runtime_counters_not_billing",
        workerVersionId: this.env.CF_VERSION_METADATA?.id ?? null,
        cpuMs: null,
        billedDurationGbSeconds: null,
        storageBytes: this.ctx.storage.sql.databaseSize,
      }),
    );
  }
}
