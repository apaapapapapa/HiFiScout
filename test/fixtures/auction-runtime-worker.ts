import { DurableObject } from "cloudflare:workers";
import { AuctionStore } from "../../src/auctions/storage.js";
import { AuctionScheduler } from "../../src/auctions/scheduler.js";
import { yahooAuctionHtmlSource } from "../../src/auctions/yahoo/parser.js";
import type { AuctionAcquisition } from "../../src/auctions/yahoo/acquisition.js";
import type { AuctionObservation } from "../../src/auctions/types.js";
import type { AuctionRuntimeState, AuctionTask } from "../../src/auctions/runtime-policy.js";

interface FixtureEnv {
  AUCTIONS: DurableObjectNamespace;
}
export class TestAuction extends DurableObject<FixtureEnv> {
  async fetch(request: Request): Promise<Response> {
    const input = (await request.json()) as {
      op: string;
      now: number;
      observations?: AuctionObservation[];
      task?: AuctionTask;
      state?: AuctionRuntimeState;
      response?: AuctionAcquisition;
      action?: "pause" | "resume" | "wake";
      categories?: string[];
      id?: string;
      text?: string;
      failCommit?: boolean;
    };
    const store = new AuctionStore(this.ctx.storage);
    store.resetUsage();
    const calls: string[] = [];
    const scheduler = new AuctionScheduler(
      store,
      {
        request: async (url) => {
          calls.push(url);
          return (
            input.response ?? {
              status: 503,
              text: null,
              retryAfter: null,
              authenticationRequired: false,
            }
          );
        },
      },
      yahooAuctionHtmlSource,
      () => true,
      () => input.now,
    );
    if (input.op === "state" && input.state) store.saveRuntime(input.state);
    if (input.op === "task" && input.task) store.task(input.task);
    if (input.op === "control") await scheduler.control(input.action ?? "wake", input.categories);
    if (input.op === "alarm") await scheduler.alarm();
    if (input.op === "apply") {
      try {
        this.ctx.storage.transactionSync(() => {
          for (const observation of input.observations ?? []) store.apply(observation);
          if (input.failCommit) throw new Error("injected_before_receipt");
        });
      } catch (error) {
        if (!input.failCommit) throw error;
      }
    }
    if (input.op === "retain") store.retain(input.now);
    const usage = structuredClone(store.usage);
    return Response.json({
      usage,
      calls,
      state: store.runtime(input.now),
      item: input.id ? store.item(input.id) : null,
      tasks: store.sql("task", "SELECT * FROM auction_tasks ORDER BY id"),
      hits: input.text
        ? store.sql(
            "search",
            "SELECT rowid FROM auction_fts WHERE auction_fts MATCH ?",
            `"${input.text}"`,
          )
        : [],
      receipts: store.sql("receipt", "SELECT * FROM auction_page_receipts"),
      alarm: await this.ctx.storage.getAlarm(),
    });
  }
  async alarm(): Promise<void> {
    /* Fixture clock drives alarms explicitly. */
  }
}
export default {
  fetch(request: Request, env: FixtureEnv) {
    return env.AUCTIONS.get(env.AUCTIONS.idFromName("yahoo-auctions-v1")).fetch(request);
  },
};
