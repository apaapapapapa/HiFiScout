import { YahooAuctions } from "../src/auctions/durable-object.js";
import { AuctionStore } from "../src/auctions/storage.js";
import { initialAuctionRuntime } from "../src/auctions/runtime-policy.js";
export { TestAuction } from "./fixtures/auction-runtime-worker.js";

export class TestAdmission extends YahooAuctions {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      const store = new AuctionStore(this.ctx.storage);
      const state = initialAuctionRuntime(Date.now());
      state.paused = false;
      state.publicPaused = false;
      state.reserved.requests = 4000;
      store.saveRuntime(state);
      return Response.json({ ok: true });
    }
    if (url.pathname === "/state")
      return Response.json(new AuctionStore(this.ctx.storage).runtime(Date.now()));
    return super.fetch(request);
  }
}
export default {
  fetch: (
    request: Request,
    env: { ADMISSION: DurableObjectNamespace; AUCTIONS: DurableObjectNamespace },
  ) => {
    const namespace = new URL(request.url).pathname === "/fixture" ? env.AUCTIONS : env.ADMISSION;
    return namespace.get(namespace.idFromName("admission-test")).fetch(request);
  },
};
