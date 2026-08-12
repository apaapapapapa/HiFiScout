import { expect, test } from "@playwright/test";

test("data quality admin endpoint keeps a stable contract", async ({ request }) => {
  const adminToken = process.env.HIFISCOUT_ADMIN_TOKEN;
  const response = await request.get("/api/admin/data-quality/status", {
    headers: adminToken ? { authorization: `Bearer ${adminToken}` } : {},
  });

  if (!adminToken) {
    expect(response.status()).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    return;
  }

  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(["healthy", "warning", "critical", "unknown"]).toContain(body.status);
  expect(Array.isArray(body.shops)).toBeTruthy();
  expect(typeof body.checkedAt).toBe("string");
  for (const shop of body.shops) {
    expect(typeof shop.shop).toBe("string");
    expect(typeof shop.metrics).toBe("object");
    expect(shop.metrics).toHaveProperty("manufacturerUnknown");
    expect(shop.metrics).toHaveProperty("categoryUnclassified");
    expect(shop.metrics).toHaveProperty("identityUnresolved");
    expect(shop.metrics).toHaveProperty("inventoryUnknown");
    expect(shop.metrics).toHaveProperty("modelMissing");
    expect(shop.metrics).toHaveProperty("parserFailure");
    expect(shop.metrics).toHaveProperty("evidenceCoverage");
    expect(shop.metrics).toHaveProperty("itemCount");
  }
});
