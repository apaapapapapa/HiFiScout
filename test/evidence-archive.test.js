import test from "node:test";
import assert from "node:assert/strict";
import {
  archiveEvidence,
  evidenceRetentionClass,
  sanitizeEvidenceHtml,
  sha256Hex,
  shouldArchiveEvidence,
} from "../src/evidence/evidence-archive.js";

function fakeDb({ duplicate = null } = {}) {
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

test("archive writes HTML to R2 and only metadata to D1", async () => {
  const db = fakeDb();
  const puts = [];
  const env = {
    DB: db,
    EVIDENCE_BUCKET: {
      async put(key, body, options) {
        puts.push({ key, body, options });
      },
    },
  };

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
  assert.match(db.writes[0].sql, /INSERT INTO evidence_archive/);
  assert.ok(!db.writes[0].binds.some((value) => String(value).includes("<html>")));
});

test("duplicate content is not written to R2 again", async () => {
  const db = fakeDb({ duplicate: { id: 1, r2_object_key: "evidence/short/test/existing.html" } });
  let putCount = 0;
  const result = await archiveEvidence({
    env: {
      DB: db,
      EVIDENCE_BUCKET: {
        async put() {
          putCount += 1;
        },
      },
    },
    shopKey: "test",
    reason: "parser_failure",
    html: "<html>same</html>",
    capturedAt: "2026-08-12T10:00:00.000Z",
  });

  assert.equal(result.status, "deduplicated");
  assert.equal(putCount, 0);
  assert.equal(db.writes.length, 0);
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
