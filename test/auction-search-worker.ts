import { DurableObject } from "cloudflare:workers";
import { AuctionStore } from "../src/auctions/storage.js";
import { searchAuctions } from "../src/auctions/search.js";
import {
  AUCTION_CATALOG_RULE,
  AuctionCatalogMaintenance,
  type AuctionCatalogEntry,
} from "../src/auctions/catalog.js";
import { AuctionQueryError } from "../src/api/auction-query.js";
import type { AuctionObservation } from "../src/auctions/types.js";
export class TestSearch extends DurableObject {
  async fetch(request: Request) {
    const input = (await request.json()) as {
      op: string;
      now: number;
      query?: string;
      observations?: AuctionObservation[];
      entries?: AuctionCatalogEntry[];
    };
    const store = new AuctionStore(this.ctx.storage);
    store.resetUsage();
    if (input.op === "apply")
      this.ctx.storage.transactionSync(() => {
        for (const [index, o] of (input.observations ?? []).entries()) store.apply(o, index);
      });
    if (input.op === "cache")
      this.ctx.storage.transactionSync(() => {
        // Distinct retained candidate keys exercise the largest cache join, not a second D1 catalog.
        store.sql(
          "catalog",
          "INSERT INTO catalog_match_cache SELECT auction_id,?,? FROM auction_items",
          JSON.stringify({ rule: AUCTION_CATALOG_RULE, revision: "measured" }),
          input.now + 900_000,
        );
        store.sql(
          "catalog",
          "UPDATE auction_items SET match_key=auction_id,match_revision='measured',catalog_id=12,manufacturer='denon',category='AMP.INTEGRATED',identity=?",
          JSON.stringify({
            catalogProductId: 12,
            manufacturer: "DENON",
            model: "PMA-1700NE",
            categoryId: "AMP.INTEGRATED",
          }),
        );
      });
    if (input.op === "match")
      await new AuctionCatalogMaintenance(store, { read: async () => input.entries ?? [] }).refresh(
        input.now,
      );
    try {
      const result =
        input.op === "search"
          ? searchAuctions(store, new URL(`https://test.invalid/?${input.query ?? ""}`), input.now)
          : null;
      return Response.json({ result, usage: store.usage });
    } catch (error) {
      if (error instanceof AuctionQueryError)
        return Response.json({ error: error.message }, { status: 400 });
      throw error;
    }
  }
}
export default {
  fetch: (request: Request, env: { AUCTIONS: DurableObjectNamespace }) =>
    env.AUCTIONS.get(env.AUCTIONS.idFromName(new URL(request.url).pathname)).fetch(request),
};
