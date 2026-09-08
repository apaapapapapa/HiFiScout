import { test, expect } from "./fixtures.js";

test("non-string crawl actions are rejected before crossing the service binding", async ({
  request,
  app,
}) => {
  const headers = { ...(await app.headers()), origin: app.url };
  for (const action of [["pause"], { action: "pause" }, null, 1]) {
    const response = await request.post("/api/admin/crawls/control", {
      headers,
      data: { shopKey: "hifido", action },
    });
    expect(response.status()).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_crawl_control" });
  }
  expect(app.state.crawls.actions).toEqual([]);
});
