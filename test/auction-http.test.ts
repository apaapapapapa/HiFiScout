import { it, expect, vi, beforeEach } from "vite-plus/test";
const flags = vi.hoisted(() => ({ enabled: false }));
vi.mock("../src/auctions/yahoo/policy.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  yahooAuctionAccess: () => ({
    collect: false,
    search: flags.enabled,
    display: flags.enabled,
    blockers: [],
  }),
}));
import { handleAuctionRoute } from "../src/http/auctions.js";
const fetch = vi.fn(async () => Response.json({ items: [], hasMore: false, nextCursor: null }));
const get = vi.fn(() => ({ fetch }));
const env = { YAHOO_AUCTIONS: { get, idFromName: vi.fn(() => "id") } } as unknown as Env;
beforeEach(() => {
  flags.enabled = true;
  vi.clearAllMocks();
  fetch.mockImplementation(async () =>
    Response.json({ items: [], hasMore: false, nextCursor: null }),
  );
});
it("validates and blocks missing rate control before touching the auction DO", async () => {
  for (const query of [
    "q=A8",
    "cursor=bad",
    "min=100&max=1",
    "limit=100",
    "sort=sql",
    "unit=pair&unit=set",
  ]) {
    expect(
      (
        await handleAuctionRoute(
          new Request(`https://test.invalid/api/auctions?${query}`),
          env,
          false,
        )
      )?.status,
    ).toBe(400);
  }
  expect(
    (await handleAuctionRoute(new Request("https://test.invalid/api/auctions"), env, true))?.status,
  ).toBe(503);
  expect(get).not.toHaveBeenCalled();
});
it("keeps deployment disable authoritative and features independent of DO availability", async () => {
  flags.enabled = false;
  expect(
    (await handleAuctionRoute(new Request("https://test.invalid/api/auctions"), env, false))
      ?.status,
  ).toBe(404);
  const features = await handleAuctionRoute(
    new Request("https://test.invalid/api/auction-features"),
    env,
    true,
  );
  expect(await features?.json()).toEqual({ search: false, display: false });
  expect(get).not.toHaveBeenCalled();
});
it("reads only the stable DO namespace and preserves pause/unavailability without caching", async () => {
  fetch.mockImplementation(async () => Response.json({ error: "auction_paused" }, { status: 503 }));
  const result = await handleAuctionRoute(
    new Request("https://test.invalid/api/auctions?catalog=12&limit=8"),
    env,
    false,
  );
  expect(result?.status).toBe(503);
  expect(result?.headers.get("cache-control")).toBe("no-store");
  expect(await result?.json()).toEqual({ error: "auction_paused" });
  expect(new URL((fetch.mock.calls[0] as unknown as [Request])[0].url).pathname).toBe("/search");
  fetch.mockRejectedValue(new Error("quota"));
  expect(
    (await handleAuctionRoute(new Request("https://test.invalid/api/auctions"), env, false))
      ?.status,
  ).toBe(503);
});
