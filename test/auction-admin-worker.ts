import { YahooAuctions } from "../src/auctions/durable-object.js";
import { AuctionStore } from "../src/auctions/storage.js";
import { initialAuctionRuntime } from "../src/auctions/runtime-policy.js";
import { auctionAdminStatus } from "../src/auctions/status.js";
import type { AuctionSnapshot } from "../src/auctions/types.js";
export class TestAuctionAdmin extends YahooAuctions {
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      const now = Date.now();
      const original = (await request.json()) as AuctionSnapshot;
      const store = new AuctionStore(this.ctx.storage);
      this.ctx.storage.transactionSync(() => {
        store.saveRuntime(initialAuctionRuntime(now));
        for (let i = 0; i < 2000; i++) {
          const o = structuredClone(original);
          o.auctionId = `a${String(i).padStart(6, "0")}`;
          o.sourceUrl = `https://auctions.yahoo.co.jp/jp/auction/${o.auctionId}`;
          o.stamp.observedAt = new Date(now).toISOString();
          for (const fact of Object.values(o.live)) if (fact) fact.observedAt = o.stamp.observedAt;
          o.live.scheduledEndAt = {
            value: new Date(now - 1000).toISOString(),
            observedAt: o.stamp.observedAt,
          };
          o.live.sourceState = { value: "open", observedAt: o.stamp.observedAt };
          store.apply(o, i);
          store.task({
            id: `confirm:${o.auctionId}`,
            kind: "confirm",
            categoryId: "2084037425",
            auctionId: o.auctionId,
            page: 1,
            due: i < 10 ? Number.MAX_SAFE_INTEGER : now + 3600000,
            attempts: 0,
            sequence: null,
          });
          store.sql("catalog", "INSERT INTO auction_catalog_replays VALUES(?, '')", o.auctionId);
        }
      });
      return Response.json({ ok: true });
    }
    if (path === "/measure-status") {
      const store = new AuctionStore(this.ctx.storage);
      store.resetUsage();
      const status = await auctionAdminStatus(store, this.env, Date.now());
      return Response.json({ status, usage: store.usage, alarms: store.alarmOperations });
    }
    if (path === "/state")
      return Response.json(new AuctionStore(this.ctx.storage).runtime(Date.now()));
    return super.fetch(request);
  }
}
export default {
  fetch: (request: Request, env: { AUCTIONS: DurableObjectNamespace }) =>
    env.AUCTIONS.get(env.AUCTIONS.idFromName("fixture")).fetch(request),
};
