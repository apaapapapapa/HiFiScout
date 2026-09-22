import { DurableObject } from "cloudflare:workers";
import { AuctionStore } from "../src/auctions/storage.js";
import { AuctionCatalogMaintenance, type AuctionCatalogEntry } from "../src/auctions/catalog.js";
import type { AuctionObservation } from "../src/auctions/types.js";

export class TestCatalog extends DurableObject {
  async fetch(request: Request) {
    const input = (await request.json()) as {
      op: string;
      now: number;
      observations?: AuctionObservation[];
      entries?: AuctionCatalogEntry[];
      pauseDuringRead?: boolean;
    };
    const store = new AuctionStore(this.ctx.storage);
    store.resetUsage();
    const calls: string[][] = [];
    const maintenance = new AuctionCatalogMaintenance(store, {
      read: async (inputs) => {
        calls.push(inputs.map((input) => input.key));
        if (input.pauseDuringRead) {
          const state = store.runtime(input.now);
          state.paused = true;
          state.generation++;
          store.saveRuntime(state);
        }
        return input.entries ?? [];
      },
    });
    if (input.op === "apply")
      this.ctx.storage.transactionSync(() => {
        for (const observation of input.observations ?? []) store.apply(observation);
      });
    if (input.op === "retain") store.retain(input.now);
    if (input.op === "refresh") await maintenance.refresh(input.now);
    if (input.op === "run") {
      const state = store.runtime(input.now);
      state.paused = false;
      store.saveRuntime(state);
      await maintenance.run(input.now);
    }
    const usage = structuredClone(store.usage);
    return Response.json({
      usage,
      calls,
      items: store.sql(
        "catalog",
        "SELECT auction_id,identity,match_revision,match_key FROM auction_items ORDER BY auction_id",
      ),
      cache: store.sql("catalog", "SELECT * FROM catalog_match_cache ORDER BY key"),
      pending: store.sql("catalog", "SELECT * FROM auction_catalog_replays"),
      nextDue: maintenance.nextDue(input.now),
    });
  }
}
export default {
  fetch: (request: Request, env: { AUCTIONS: DurableObjectNamespace }) =>
    env.AUCTIONS.get(env.AUCTIONS.idFromName(new URL(request.url).pathname)).fetch(request),
};
