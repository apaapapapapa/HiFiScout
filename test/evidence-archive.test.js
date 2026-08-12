import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveEvidence,
  evidenceRetentionClass,
  sanitizeEvidenceHtml,
  sha256Hex,
  shouldArchiveEvidence,
} from "../src/evidence/evidence-archive.js";

function fakeDb({ duplicate = null, dailyObjects = 0, dailyBytes = 0, shopDailyObjects = 0, burstObjects = 0, storedBytes = 0 } = {}) {
  const writes = [];
  return {
    writes,
    prepare(sql) {
      return {
        bind(...binds) {
          return {
            async all() {
              if (/SELECT id, r2_object_key/.test(sql)) {
                return { results: duplicate ? [duplicate] : [] };
              }
              if (/COUNT\(\*\) AS object_count, COALESCE\(SUM\(content_bytes\)/.test(sql)) {
                return { results: [{ object_count: dailyObjects, byte_count: dailyBytes }] };
              }
              if (/WHERE shop_key = \? AND captured_at >=/.test(sql)) {
                return { results: [{ object_count: shopDailyObjects }] };
              }
              if (/WHERE shop_key = \? AND reason = \? AND captured_at >=/.test(sql)) {
                return { results: [{ object_count: burstObjects }] };
              }
              if (/COALESCE\(SUM\(content_bytes\), 0\) AS byte_count/.test(sql)) {
                return { results: [{ byte_count: storedBytes }] };
              }
              return { results: [] };
            },
            async run() {
              writes.push({ sql, binds });
              return { success: true, meta: { changes: 1 } };
            },
          };
        },
      };
    },
  };
}

function fakeEnv(db, overrides = {}) {
  const puts = [];
  return {
    puts,
    env: {
      DB: db,
      EVIDENCE_BUCKET: {
        async put(key, body, options) {
          puts.push({ key, body, options });
        },
      },
      ...overrides,
    },
  };
}

test("only explicit evidence reasons are archiveable and have retention classes", () => {
  assert.equal(shouldArchiveEvidence("parser_failure"), true);
  assert.equal(evidenceRetentionClass("parser_failure"), "short");
  assert.equal(evidenceRetentionClass("classification_unresolved"), "long");
  assert.equal(shouldArchiveEvidence("normal_crawl"), false);
});

test("evidence sanitization redacts common credential-bearing HTML fields", () => {
  const html = '<input name="csrf_token" value="secret"><meta name="auth-token" content="abc">';
  const sanitized = sanitizeEvidenceHtml(html);
  assert.doesNotMatch(sanitized, /secret|abc/);
  assert.match(sanitized, /\[REDACTED\]/);
});

test("content hashing is deterministic", async () => {
  assert.equal(await sha256Hex("same"), await sha256Hex("same"));
  assert.notEqual(await sha256Hex("same"), await sha256Hex("different"));
});

test("archive writes HTML to R2 and records content bytes in D1 metadata", async () => {
  const db = fakeDb();
  const { env, puts } = fakeEnv(db);

  const result = await archiveEvidence({
    env,
    shopKey: "test-shop",
    reason: "parser_failure",
    html: "<html><body>broken</body></html>",
    crawlRunId: 12,
    capturedAt: "2026-08-12T10:00:00.000Z",
    eventId: "event-1",
  });

  assert.equal(result.status, "archived");
  assert.equal(puts.length, 1);
  assert.match(puts[0].key, /^evidence\/short\/test-shop\/2026\/08\/12\/event-1\.html$/);
  assert.equal(db.writes.length, 1);
  assert.match(db.writes[0].sql, /content_bytes/);
  assert.equal(db.writes[0].binds[7], result.contentBytes);
  assert.ok(!db.writes[0].binds.some((value) => String(value).includes("<html>")));
});

test("duplicate content is not written to R2 again", async () => {
  const db = fakeDb({ duplicate: { id: 1, r2_object_key: "evidence/short/test/existing.html" } });
  const { env, puts } = fakeEnv(db);
  const result = await archiveEvidence({
    env,
    shopKey: "test",
    reason: "parser_failure",
    html: "<html>same</html>",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "deduplicated");
  assert.equal(puts.length, 0);
  assert.equal(db.writes.length, 0);
});

test("daily object cap suppresses evidence before R2 write", async () => {
  const db = fakeDb({ dailyObjects: 5 });
  const { env, puts } = fakeEnv(db, { EVIDENCE_DAILY_MAX_OBJECTS: "5" });
  const result = await archiveEvidence({
    env,
    shopKey: "test",
    reason: "parser_failure",
    html: "<html>new failure</html>",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "daily_object_cap");
  assert.equal(puts.length, 0);
  assert.equal(db.writes.length, 0);
});

test("daily byte cap accounts for the incoming object", async () => {
  const db = fakeDb({ dailyBytes: 95 });
  const { env, puts } = fakeEnv(db, { EVIDENCE_DAILY_MAX_BYTES: "100" });
  const result = await archiveEvidence({
    env,
    shopKey: "test",
    reason: "parser_failure",
    html: "1234567890",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "daily_byte_cap");
  assert.equal(puts.length, 0);
});

test("shop daily object cap isolates a noisy crawler", async () => {
  const db = fakeDb({ shopDailyObjects: 3 });
  const { env, puts } = fakeEnv(db, { EVIDENCE_SHOP_DAILY_MAX_OBJECTS: "3" });
  const result = await archiveEvidence({
    env,
    shopKey: "noisy-shop",
    reason: "crawl_validation_failure",
    html: "<html>failure</html>",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "shop_daily_object_cap");
  assert.equal(puts.length, 0);
});

test("burst sampling suppresses most repeated same-reason evidence", async () => {
  const db = fakeDb({ burstObjects: 2 });
  const { env, puts } = fakeEnv(db, {
    EVIDENCE_BURST_MAX_OBJECTS: "2",
    EVIDENCE_BURST_SAMPLE_RATE: "2147483647",
  });
  const result = await archiveEvidence({
    env,
    shopKey: "test",
    reason: "parser_failure",
    html: "<html>burst failure</html>",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "suppressed");
  assert.equal(result.reason, "burst_sampled");
  assert.equal(puts.length, 0);
});

test("storage warning threshold does not block useful evidence", async () => {
  const db = fakeDb({ storedBytes: 100 });
  const { env, puts } = fakeEnv(db, { EVIDENCE_STORAGE_WARNING_BYTES: "100" });
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (value) => warnings.push(String(value));
  try {
    const result = await archiveEvidence({
      env,
      shopKey: "test",
      reason: "parser_failure",
      html: "<html>important failure</html>",
      capturedAt: "2026-08-12T10:00:00.000Z",
    });
    assert.equal(result.status, "archived");
    assert.equal(puts.length, 1);
    assert.ok(warnings.some((value) => value.includes("evidence_storage_warning")));
  } finally {
    console.warn = originalWarn;
  }
});

test("R2 failures remain best effort and do not throw", async () => {
  const db = fakeDb();
  const result = await archiveEvidence({
    env: {
      DB: db,
      EVIDENCE_BUCKET: {
        async put() {
          throw new Error("r2 unavailable");
        },
      },
    },
    shopKey: "test",
    reason: "crawl_validation_failure",
    html: "<html>failure</html>",
  });

  assert.equal(result.status, "failed");
  assert.equal(db.writes.length, 0);
});
