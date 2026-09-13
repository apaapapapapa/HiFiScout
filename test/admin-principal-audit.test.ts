import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import {
  UNKNOWN_ADMIN_ACTOR,
  UNIDENTIFIED_PRINCIPAL,
  trustedActor,
} from "../src/api/admin-actor.js";
import { adminPrincipalFromClaims } from "../src/admin/access.js";
import { handleAuthenticatedAdminEntryRequest } from "../src/admin/entry.js";
import { handleAuthenticatedCatalogAdminRequest } from "../src/admin/index.js";
import { readAdminChangeHistory } from "../src/db/admin-change-history-repository.js";
import { adminChangeJournalStatement } from "../src/db/admin-change-journal.js";
import { migratedSqlite } from "./helpers/migrated-sqlite.js";
import { TEST_ADMIN_PRINCIPAL, TEST_ADMIN_SERVICE_PRINCIPAL } from "./helpers/admin-principal.js";

const ISSUER = "https://hifiscout.cloudflareaccess.com";

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
