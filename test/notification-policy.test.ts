import { describe, expect, it, vi } from "vite-plus/test";
import {
  allowedPushEndpoint,
  parseWatch,
  parsePushAddress,
  watchAccepts,
} from "../src/notifications/policy.js";
import { notificationQuery } from "../frontend/notifications.js";
import { handleNotificationRoute } from "../src/http/notifications.js";

describe("notification admission", () => {
  const input = {
    id: "watch-1",
    query: "q=LUXMAN&shop=hifido&maxPrice=100000&sort=updated",
    newListings: true,
    priceDrops: true,
  };
  it("preserves the saved conditions, enforces in-stock and caps hope prices without widening", () => {
    expect(parseWatch(input)?.query).toBe("q=LUXMAN&shop=hifido&inStock=true&maxPrice=100000");
    expect(notificationQuery("maxPrice=100000", "200000")).toBe("maxPrice=100000");
    expect(notificationQuery("maxPrice=100000", "90000")).toBe("maxPrice=90000");
    expect(() => notificationQuery("minPrice=100", "50")).toThrow();
    for (const query of [
      "q=amp&evil=1",
      "minPrice=200&maxPrice=1",
      "cursor=abc",
      "limit=100",
      "q=" + "x".repeat(101),
    ])
      expect(parseWatch({ ...input, query })).toBeNull();
    expect(parseWatch({ ...input, newListings: false, priceDrops: false })).toBeNull();
  });
  it("rejects arbitrary destinations, redirects via input, oversized/invalid keys", () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/a",
      "https://127.0.0.1/",
      "https://fcm.googleapis.com.evil.test/fcm/send/a",
      "https://user@web.push.apple.com/Qa",
      "https://web.push.apple.com:444/Qa",
      "https://example.test/a",
    ])
      expect(allowedPushEndpoint(endpoint)).toBe(false);
    expect(allowedPushEndpoint("https://web.push.apple.com/Qtest")).toBe(true);
    expect(allowedPushEndpoint("https://fcm.googleapis.com/fcm/send/test")).toBe(true);
    expect(
      parsePushAddress({
        endpoint: "https://web.push.apple.com/Qa",
        keys: { p256dh: "AAAA", auth: "AA" },
      }),
    ).toBeNull();
  });
  it("does not backfill notices for historical events or a disabled kind", () => {
    const watch = { ...input, device: "device", createdAt: 100, newListings: false };
    const event = {
      id: "event",
      listingId: 1,
      title: "LUXMAN",
      key: "l-1",
      at: 200,
      price: 100,
      kind: "new" as const,
    };
    expect(watchAccepts(watch, event)).toBe(false);
    expect(watchAccepts(watch, { ...event, kind: "drop", at: 99 })).toBe(false);
    expect(watchAccepts(watch, { ...event, kind: "drop" })).toBe(true);
  });
  it("refuses unavailable rate control and cross-origin writes before reaching the hub", async () => {
    const fetch = vi.fn(async () => Response.json({ ok: true }));
    const get = vi.fn(() => ({ fetch }));
    const env = {
      NOTIFICATIONS_ENABLED: "true",
      NOTIFICATIONS: { get, idFromName: () => "v1" },
    } as unknown as Env;
    const request = (origin?: string) =>
      new Request("https://site.test/api/notifications/device", {
        method: "POST",
        headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
        body: "{}",
      });
    expect((await handleNotificationRoute(request("https://site.test"), env, true))?.status).toBe(
      503,
    );
    expect((await handleNotificationRoute(request("https://evil.test"), env, false))?.status).toBe(
      403,
    );
    expect((await handleNotificationRoute(request(), env, false))?.status).toBe(403);
    expect(get).not.toHaveBeenCalled();
    expect(
      (await handleNotificationRoute(request("https://site.test"), env, false))?.headers.get(
        "cache-control",
      ),
    ).toBe("no-store");
    expect(fetch).toHaveBeenCalledOnce();
  });
});
