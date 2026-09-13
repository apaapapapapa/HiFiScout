import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  MAX_ACTOR_LENGTH,
  UNKNOWN_ADMIN_ACTOR,
  UNIDENTIFIED_PRINCIPAL,
  trustedActor,
} from "../src/api/admin-actor.js";
import { adminAiCatalog } from "../src/ai-suggestions/admin.js";
import { mergeKnowledgeCatalogProductReferences } from "../src/db/knowledge-catalog-admin-operations.js";
import { updateCatalogSpecifications } from "../src/db/catalog-specification-repository.js";
import { saveModelFactsAdmin } from "../src/db/model-fact-admin-repository.js";
import type { CatalogSpecifications } from "../src/catalog/types.js";
import type { ModelFactWriteInput } from "../src/catalog/types.js";
import { adminPrincipalFromClaims } from "../src/admin/access.js";
import { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import { readAdminChangeHistory } from "../src/db/admin-change-history-repository.js";
import { adminChangeJournalStatement } from "../src/db/admin-change-journal.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { TEST_ADMIN_PRINCIPAL, TEST_ADMIN_SERVICE_PRINCIPAL } from "./helpers/admin-principal.js";

const ISSUER = "https://hifiscout.cloudflareaccess.com";

const SPECIFICATION: CatalogSpecifications = {
  widthMm: 440,
  heightMm: null,
  depthMm: 400,
  weightKg: 12.5,
  inputs: [{ connector: "RCA ライン", count: 3 }],
  outputs: [],
  main: [{ name: "定格出力", value: "100 W / 8 Ω" }],
  sourceUrl: "https://example.test/manual",
};

const MODEL_FACT_WRITE: ModelFactWriteInput = {
  id: null,
  expectedVersion: null,
  reverify: false,
  fact: {
    kind: "successor",
    relatedProductId: 700002,
    familyName: "",
    position: null,
    state: "verified",
    sourceId: null,
    manualNote: "公式資料で後継機種の関係を確認しました。",
    manufacturerJustification: "",
  },
};

function claims(overrides: Record<string, unknown> = {}) {
  return { iss: ISSUER, aud: "admin", exp: 4_102_444_800, ...overrides };
}

test("a person's identity comes from the issuer and subject, never the display email", () => {
  const principal = adminPrincipalFromClaims(
    claims({ sub: "abc-123", email: "operator@example.test" }),
  );
  assert.deepEqual(principal, {
    kind: "user",
    actor: "access:user:hifiscout.cloudflareaccess.com/abc-123",
    email: "operator@example.test",
  });
  // An address can be reassigned, so it is display only and never part of the stored identity.
  assert.equal(principal?.actor.includes("operator@example.test"), false);
});

test("the issuer is part of the identity because sub is unique only within one account", () => {
  const first = adminPrincipalFromClaims(claims({ sub: "shared" }));
  const second = adminPrincipalFromClaims(
    claims({ iss: "https://other.cloudflareaccess.com", sub: "shared" }),
  );
  assert.notEqual(first?.actor, second?.actor);
});

test("a service token is recorded as a service, not as a person", () => {
  const principal = adminPrincipalFromClaims(
    // Cloudflare sends an empty `sub` and the client ID in `common_name` for a service token.
    claims({ sub: "", common_name: "ci-client-id" }),
  );
  assert.deepEqual(principal, {
    kind: "service",
    actor: "access:service:hifiscout.cloudflareaccess.com/ci-client-id",
    email: null,
  });
});

test("claims are re-validated for type and shape, not trusted for being signed", () => {
  assert.equal(adminPrincipalFromClaims(claims({ sub: 42 })), null);
  assert.equal(adminPrincipalFromClaims(claims({ sub: "   " })), null);
  assert.equal(adminPrincipalFromClaims(claims({ sub: "a".repeat(300) })), null);
  assert.equal(adminPrincipalFromClaims(claims({ sub: "bad\nsubject" })), null);
  // A non-HTTPS issuer is not an Access domain this Worker will build an identity from.
  assert.equal(adminPrincipalFromClaims(claims({ iss: "http://evil.test", sub: "x" })), null);

  const oddEmail = adminPrincipalFromClaims(claims({ sub: "abc", email: 7 }));
  assert.equal(oddEmail?.email, null, "an unusable email is dropped, not coerced");
});

test("only the identities this system issues survive the RPC boundary", () => {
  assert.equal(trustedActor(TEST_ADMIN_PRINCIPAL.actor), TEST_ADMIN_PRINCIPAL.actor);
  assert.equal(
    trustedActor(TEST_ADMIN_SERVICE_PRINCIPAL.actor),
    TEST_ADMIN_SERVICE_PRINCIPAL.actor,
  );
  for (const forged of [
    undefined,
    null,
    42,
    "",
    "   ",
    "root",
    "access_admin",
    "access:admin:x/y",
    "access:user:no-subject",
    "access:user:host/with space",
    `access:user:host/${"a".repeat(300)}`,
    { actor: "access:user:host/abc" },
  ]) {
    assert.equal(
      trustedActor(forged),
      UNKNOWN_ADMIN_ACTOR,
      `${JSON.stringify(forged)} is not an identity`,
    );
  }
});

test("a login Access allowed but cannot identify stays authorized and is recorded as unknown", () => {
  // Attribution is not authorization: refusing here would turn a gap in the audit trail into a
  // lockout, and the change is simply stored with no subject instead.
  assert.equal(UNIDENTIFIED_PRINCIPAL.kind, "unknown");
  assert.equal(UNIDENTIFIED_PRINCIPAL.actor, UNKNOWN_ADMIN_ACTOR);
  assert.equal(trustedActor(UNIDENTIFIED_PRINCIPAL.actor), UNKNOWN_ADMIN_ACTOR);
});

test("the verified subject reaches the change history, and unknown history stays unknown", async () => {
  const { db } = migratedSqlite();
  const now = "2026-09-13T00:00:00.000Z";

  await db.batch(
    adminChangeJournalStatement(db, "listing", 42, { model: "OLD" }, { model: "NEW" }, now, {
      actor: TEST_ADMIN_PRINCIPAL.actor,
    }),
  );
  // A row as an older deployment wrote it: the column exists, nothing was recorded in it.
  await db
    .prepare(
      `INSERT INTO admin_product_change_log
        (operation_id, target_kind, target_id, before_json, after_json, created_at, restored_from)
      VALUES ('legacy-operation', 'listing', 42, ?, ?, ?, '')`,
    )
    .bind(
      JSON.stringify({ model: "A" }),
      JSON.stringify({ model: "B" }),
      "2026-09-12T00:00:00.000Z",
    )
    .run();

  const history = await readAdminChangeHistory(db, "listing", 42);
  const recorded = history.items.find((item) => item.after.model === "NEW");
  const legacy = history.items.find((item) => item.operationId === "legacy-operation");

  assert.equal(recorded?.actor, TEST_ADMIN_PRINCIPAL.actor);
  // Never attributed to whoever happens to be signed in now.
  assert.equal(legacy?.actor, null);
});

test("a forged actor in the payload cannot become the recorded subject", async () => {
  const { db } = migratedSqlite();
  await db.batch(
    adminChangeJournalStatement(
      db,
      "listing",
      7,
      { model: "OLD" },
      { model: "NEW" },
      "2026-09-13T00:00:00.000Z",
      { actor: "access_admin" },
    ),
  );

  const history = await readAdminChangeHistory(db, "listing", 7);
  assert.equal(history.items[0]?.actor, null, "an unrecognized actor is stored as no subject");
});

test("one request verifies its token once and hands the subject to the handler", async () => {
  // `saveModelFacts` used to re-verify the request's JWT to recover `sub`. The handler now receives
  // the subject, so a second verification would be a second signature check for the same request.
  let fetches = 0;
  const env = {
    CATALOG_ADMIN: {
      getModelFacts: async () => ({ facts: [] }),
      saveModelFacts: async (_id: number, _input: unknown, actor: string) => ({ actor }),
    },
    ACCESS_TEAM_DOMAIN: ISSUER,
    ACCESS_AUD: "admin",
  } as unknown as Parameters<typeof handleAuthenticatedCatalogAdminRequest>[1];

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetches += 1;
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    const response = await handleAuthenticatedCatalogAdminRequest(
      new Request("https://admin.example.test/api/admin/knowledge-catalog/products/5/model-facts", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://admin.example.test" },
        body: JSON.stringify({
          id: null,
          expectedVersion: null,
          reverify: false,
          fact: {
            kind: "successor",
            relatedProductId: 700002,
            familyName: "",
            position: null,
            state: "verified",
            sourceId: null,
            manualNote: "公式資料で後継機種の関係を確認しました。",
            manufacturerJustification: "",
          },
        }),
      }),
      env,
      TEST_ADMIN_PRINCIPAL,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { actor: TEST_ADMIN_PRINCIPAL.actor });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(fetches, 0, "no JWKS fetch: the handler did not verify the token again");
});

test("each request carries its own subject, with nothing shared between them", async () => {
  const seen: string[] = [];
  const env = {
    CATALOG_ADMIN: {
      updateListing: async (_id: number, _input: unknown, actor: string) => {
        seen.push(actor);
        return { listing: { id: 1 } };
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];

  const update = (principal: typeof TEST_ADMIN_PRINCIPAL) =>
    handleAuthenticatedAdminEntryRequest(
      new Request("https://admin.example.test/api/admin/listings/1", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "https://admin.example.test" },
        body: JSON.stringify({ presentationColor: "黒" }),
      }),
      env,
      principal,
    );

  // Interleaved on purpose: a module-level "current user" would make these two agree.
  await Promise.all([update(TEST_ADMIN_PRINCIPAL), update(TEST_ADMIN_SERVICE_PRINCIPAL)]);

  assert.deepEqual(
    [...seen].sort(),
    [TEST_ADMIN_PRINCIPAL.actor, TEST_ADMIN_SERVICE_PRINCIPAL.actor].sort(),
  );
});

test("a background job records who asked, distinct from the system that runs it", async () => {
  const commands: { command: unknown; actor?: string }[] = [];
  const env = {
    CATALOG_ADMIN: {
      adminJobs: async (command: unknown, actor?: string) => {
        commands.push({ command, actor });
        return { job: { id: "job-1" } };
      },
    },
  } as unknown as Parameters<typeof handleAuthenticatedAdminEntryRequest>[1];

  const response = await handleAuthenticatedAdminEntryRequest(
    new Request("https://admin.example.test/api/admin/jobs", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://admin.example.test" },
      body: JSON.stringify({
        action: "create",
        id: "00000000-0000-4000-8000-000000000009",
        kind: "model",
        label: "一括再判定",
        total: 0,
        // A caller trying to name itself. The command parser rebuilds the command from a fixed set
        // of fields, so this never reaches the job, and the subject travels beside the command.
        actor: "access:user:evil.cloudflareaccess.com/attacker",
      }),
    }),
    env,
    TEST_ADMIN_PRINCIPAL,
  );

  assert.equal(response.status, 200);
  assert.equal(commands.length, 1);
  assert.equal(commands[0]?.actor, TEST_ADMIN_PRINCIPAL.actor);
  assert.equal(
    JSON.stringify(commands[0]?.command).includes("attacker"),
    false,
    "the request body's actor never reaches the job",
  );
});

test("no admin path puts a JWT or a cookie where a job, a row or a log could keep it", () => {
  // The principal is the only thing that travels, and it holds no credential material.
  assert.deepEqual(Object.keys(TEST_ADMIN_PRINCIPAL).sort(), ["actor", "email", "kind"]);
  assert.equal(TEST_ADMIN_PRINCIPAL.actor.includes("."), true, "an Access host, not a JWT");
  assert.equal(
    TEST_ADMIN_PRINCIPAL.actor.split(".").length < 4,
    true,
    "not three dot-separated JWT parts",
  );
});

test("a merge and its audit row commit together, or neither does", async () => {
  // The duplicate is gone once the merge batch succeeds, so an audit row written afterwards could
  // fail with the merge already applied: the caller would report a failure, the retry would find no
  // source product, and the merge would be the one manual operation with no record of who ran it.
  const OPERATION = "11111111-1111-4111-8111-111111111111";
  for (const failure of ["none", "merge", "audit"] as const) {
    const { db, sqlite } = migratedSqlite();
    try {
      sqlite.exec(
        `INSERT INTO knowledge_catalog_products (id, manufacturer_id, canonical_model, normalized_model, created_at, updated_at)
         VALUES (9000001,'luxman','test','TEST','2026-09-07','2026-09-07'),
                (9000002,'luxman','test2','TEST2','2026-09-07','2026-09-07')`,
      );
      await updateCatalogSpecifications(db, 9000002, SPECIFICATION);
      // A differing source-backed record on the survivor makes the merge's own statements fail.
      if (failure === "merge")
        await updateCatalogSpecifications(db, 9000001, { ...SPECIFICATION, widthMm: 450 });
      // A taken operation id makes the audit insert -- and nothing else -- fail.
      if (failure === "audit")
        await db
          .prepare(
            `INSERT INTO admin_product_change_log
              (operation_id, target_kind, target_id, before_json, after_json, created_at, restored_from, actor)
            VALUES (?, 'catalog', 9000003, '{}', '{}', '2026-09-06T00:00:00.000Z', '', '')`,
          )
          .bind(OPERATION)
          .run();

      const merge = mergeKnowledgeCatalogProductReferences(
        db,
        9000001,
        { id: 9000002, canonicalModel: "test2", canonicalName: "test2" },
        "2026-09-07T00:00:00.000Z",
        adminChangeJournalStatement(
          db,
          "catalog",
          9000002,
          { merged_into: "" },
          { merged_into: "9000001" },
          "2026-09-07T00:00:00.000Z",
          { actor: TEST_ADMIN_PRINCIPAL.actor, operationId: OPERATION },
        ),
      );
      if (failure === "none") await merge;
      else await assert.rejects(merge);

      const survivors = await db
        .prepare("SELECT COUNT(*) AS count FROM knowledge_catalog_products WHERE id = 9000002")
        .first<{ count: number }>();
      const history = await readAdminChangeHistory(db, "catalog", 9000002);

      // Whichever statement fails, the merge and its record share one outcome. A reported failure
      // means the duplicate is still there to retry on, never a silently applied merge.
      assert.equal(Number(survivors?.count), failure === "none" ? 0 : 1, `${failure}: merge`);
      assert.equal(history.items.length, failure === "none" ? 1 : 0, `${failure}: audit row`);
      if (failure === "none") assert.equal(history.items[0]?.actor, TEST_ADMIN_PRINCIPAL.actor);
    } finally {
      sqlite.close();
    }
  }
});

test("an authorized operator this system cannot name still gets to work", async () => {
  // Access allows a token carrying neither `sub` nor a service token's `common_name`. Attribution is
  // not authorization, so the write proceeds and records no subject; refusing it would turn a gap in
  // the audit trail into a lockout.
  const { db, sqlite } = migratedSqlite();
  try {
    sqlite.exec(`INSERT INTO knowledge_catalog_products(id,manufacturer_id,canonical_model,normalized_model,canonical_name,created_at,updated_at)
      VALUES(700001,'test','A','A','Model A','2026-09-07','2026-09-07'),(700002,'test','B','B','Model B','2026-09-07','2026-09-07');`);

    const saved = (await saveModelFactsAdmin(db, 700001, MODEL_FACT_WRITE, UNKNOWN_ADMIN_ACTOR))!;
    assert.equal(saved.audits[0].actor, UNKNOWN_ADMIN_ACTOR, "recorded as unknown, not refused");

    // The AI catalog console rejected an empty actor outright, which would have failed even a read.
    const page = await adminAiCatalog(
      { DB: db } as unknown as Parameters<typeof adminAiCatalog>[0],
      { action: "list", status: "suggested", before: null },
      UNKNOWN_ADMIN_ACTOR,
    );
    assert.ok(page, "an unidentified operator can still open the AI catalog");

    // The length bound is what remains, and it still rejects an unstorable value.
    await assert.rejects(
      saveModelFactsAdmin(db, 700001, MODEL_FACT_WRITE, "a".repeat(MAX_ACTOR_LENGTH + 1)),
      /catalog_model_fact_invalid/,
    );
  } finally {
    sqlite.close();
  }
});

test("an identity too long to store is recorded as unknown rather than cut short", () => {
  // Truncating the composed actor would map two different subjects onto one stored identity, and
  // could slice a surrogate pair in half. Neither is an honest audit record.
  const budget = MAX_ACTOR_LENGTH - `access:user:${ISSUER.replace("https://", "")}/`.length;
  const shared = "s".repeat(budget);
  const first = adminPrincipalFromClaims(claims({ sub: `${shared}1` }));
  const second = adminPrincipalFromClaims(claims({ sub: `${shared}2` }));

  assert.equal(first, null);
  assert.equal(second, null);
  // The longest identity that does fit is still recorded in full.
  const fitting = adminPrincipalFromClaims(claims({ sub: shared }));
  assert.equal(fitting?.actor.length, MAX_ACTOR_LENGTH);
  assert.equal(fitting?.actor.endsWith(shared), true);
});
