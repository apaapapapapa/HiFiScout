import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { parseOfferFactChanges } from "../src/http/offer-fact-admin.js";
import { readOfferFactAdmin, updateOfferFactAdmin } from "../src/db/offer-fact-admin-repository.js";
import { effectiveOfferFacts, sellerOfferFactWrites } from "../src/db/offer-fact-repository.js";
import adminWorker, { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";

test("manual offer changes accept bounded decisions and reject unknown fields or states", () => {
  assert.deepEqual(parseOfferFactChanges({ remote_control: "absent", shop_warranty: "unknown" }), {
    remote_control: "absent",
    shop_warranty: "unknown",
  });
  for (const input of [
    null,
    [],
    {},
    { fact: "present" },
    { remote_control: true },
    { remote_control: "yes" },
  ])
    assert.equal(parseOfferFactChanges(input), null);
});

test("manual decisions preserve listing identity, zero-write repeats, atomicity and seller evidence", async () => {
  const { db, sqlite } = migratedSqlite();
  const at = "2026-09-07T00:00:00Z";
  try {
    sqlite.exec(`INSERT INTO products (id,shop_key,source_id,title,condition_text,source_url,first_seen_at,last_seen_at,last_changed_at)
      VALUES (1,'shop','one','Amp A1','リモコンあり','https://example.test/one','${at}','${at}','${at}')`);
    await db.batch(sellerOfferFactWrites(db, "shop", "one", "Amp A1", "リモコンあり", at));
    const original = sqlite.prepare("SELECT * FROM products").all();
    await updateOfferFactAdmin(db, 1, { remote_control: "absent" }, at);
    const effective = async () => (await effectiveOfferFacts(db, [1])).get(1)?.[0];
    assert.equal((await effective())?.state, "absent");
    const before = sqlite.prepare("SELECT total_changes() AS n").get()?.n;
    await updateOfferFactAdmin(db, 1, { remote_control: "absent" }, "2026-09-08T00:00:00Z");
    assert.equal(sqlite.prepare("SELECT total_changes() AS n").get()?.n, before);
    assert.equal((await effective())?.observedAt, at);
    await db.batch(sellerOfferFactWrites(db, "shop", "one", "Amp A1", "リモコンあり", at));
    assert.equal((await effective())?.state, "absent");
    sqlite.exec(`CREATE TRIGGER reject_warranty BEFORE INSERT ON product_offer_facts
      WHEN NEW.fact_id='shop_warranty' BEGIN SELECT RAISE(ABORT,'injected'); END;`);
    await assert.rejects(
      updateOfferFactAdmin(db, 1, { remote_control: "present", shop_warranty: "unknown" }),
      /injected/u,
    );
    assert.equal((await effective())?.state, "absent");
    await updateOfferFactAdmin(db, 1, { remote_control: "inherit" });
    assert.equal((await effective())?.source, "seller");
    assert.equal((await effective())?.state, "present");
    assert.deepEqual(sqlite.prepare("SELECT * FROM products").all(), original);
    assert.equal((await readOfferFactAdmin(db, 1))?.facts.length, 1);
    assert.equal(await updateOfferFactAdmin(db, 999, { remote_control: "unknown" }), null);
  } finally {
    sqlite.close();
  }
});

test("offer fact routes keep Access, same-origin, content-type and request validation boundaries", async () => {
  let calls = 0;
  const env = {
    CATALOG_ADMIN: {
      getOfferFacts: async () => {
        calls++;
        return { listingId: 1, facts: [] };
      },
      updateOfferFacts: async () => {
        calls++;
        return { listingId: 1, facts: [] };
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];
  const url = "https://admin.example.test/api/admin/listings/1/offer-facts";
  const unauthorized = await adminWorker.fetch(new Request(url), env);
  assert.notEqual(unauthorized.status, 200);
  assert.equal(calls, 0);
  const send = (body: unknown, origin = "https://admin.example.test", type = "application/json") =>
    handleAuthenticatedAdminEntryRequest(
      new Request(url, {
        method: "PATCH",
        headers: { origin, "content-type": type },
        body: JSON.stringify(body),
      }),
      env,
    );
  assert.equal(
    (await send({ remote_control: "absent" }, "https://other.example.test")).status,
    403,
  );
  assert.equal((await send({ remote_control: "absent" }, undefined, "text/plain")).status, 415);
  assert.equal((await send({ remote_control: "maybe" })).status, 400);
  assert.equal((await send({ remote_control: "x".repeat(5000) })).status, 413);
  assert.equal(calls, 0);
  assert.equal((await send({ remote_control: "unknown" })).status, 200);
  assert.equal((await handleAuthenticatedAdminEntryRequest(new Request(url), env)).status, 200);
  assert.equal(calls, 2);
});
