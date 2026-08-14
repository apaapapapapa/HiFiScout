import test from "node:test";
import assert from "node:assert/strict";

import {
  consumeKnowledgeCatalogVerificationDeadLetterBatch,
  consumeKnowledgeCatalogVerificationMessage,
} from "../src/knowledge-catalog/consumer.js";
import {
  knowledgeJobRow,
  queueDatabase,
  queueEnv,
  queueMessage,
} from "./helpers/knowledge-queue.js";
import type { KnowledgeCatalogQueueMessage } from "../src/knowledge-catalog/types.js";
import type {
  KnowledgeSourceVerification,
  KnowledgeSourceVerifier,
} from "../src/catalog/knowledge-verification/types.js";

/**
 * The queue decisions that determine whether work is repeated, dropped, or declared finished: the
 * per-domain lease, the retry and dead-letter budgets, and finalization.
 *
 * These are what stop one unreachable manufacturer from being hammered, and what stops a run from
 * being reported as successful while its jobs are still outstanding. They are asserted through the
 * message handler rather than through the repositories, because the coordination is the behavior.
 */

function deadLetterBatch(message: Message<KnowledgeCatalogQueueMessage>) {
  return { messages: [message] } as unknown as MessageBatch<KnowledgeCatalogQueueMessage>;
}

const CANDIDATE_TARGET = {
  id: 11,
  manufacturerId: "luxman",
  normalizedModel: "L-509Z",
  observedManufacturer: "LUXMAN",
  observedModel: "L-509Z",
};

/** Stands in for the network so the retry decision can be driven from a chosen verification. */
function stubVerifier(verification: KnowledgeSourceVerification) {
  return () =>
    ({
      async verifyCandidate() {
        return verification;
      },
      async verifyStoredSource() {
        return verification;
      },
      definitions: new Map(),
    }) as unknown as KnowledgeSourceVerifier;
}

/** A job whose source read has already been attempted `sourceAttempts` times. */
function sourceJobDatabase(sourceAttempts: number) {
  return queueDatabase((sql) => {
    if (sql.includes("SELECT source_attempts")) return { row: { source_attempts: sourceAttempts } };
    if (sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")) {
      return { row: knowledgeJobRow() };
    }
    return {};
  });
}

test("a transient source failure is retried with backoff instead of being recorded", async () => {
  const db = sourceJobDatabase(1);
  const { message, acks, retries } = queueMessage({ target: CANDIDATE_TARGET });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message, {
    createVerifier: stubVerifier({
      status: "error",
      sourceUrl: "https://www.luxman.co.jp/",
      sourceType: "manufacturer_official",
      httpStatus: 503,
      message: "upstream unavailable",
    }),
  });

  assert.deepEqual(result, { status: "retrying" });
  assert.equal(retries[0]?.delaySeconds, 300);
  assert.equal(acks.length, 0);
  assert.equal(
    db.ran("SET status = 'completed'").length,
    0,
    "a transient failure is not the candidate's answer, so no outcome is recorded",
  );
});

test("a transient failure stops being retried once the source budget is spent", async () => {
  const db = sourceJobDatabase(4);
  const { message, acks, retries } = queueMessage({ target: CANDIDATE_TARGET });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message, {
    createVerifier: stubVerifier({
      status: "error",
      sourceUrl: "https://www.luxman.co.jp/",
      sourceType: "manufacturer_official",
      httpStatus: 503,
      message: "upstream unavailable",
    }),
  });

  assert.deepEqual(result, { status: "completed", outcome: "error" });
  assert.equal(retries.length, 0);
  assert.equal(acks.length, 1);
  assert.equal(db.ran("SET status = 'completed'").length, 1);
});

test("a conclusive failure is recorded on the first attempt rather than retried", async () => {
  // `not_found` is an answer about the page: fetching it again returns the same thing.
  const db = sourceJobDatabase(1);
  const { message, acks, retries } = queueMessage({ target: CANDIDATE_TARGET });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message, {
    createVerifier: stubVerifier({
      status: "not_found",
      sourceUrl: "",
      sourceType: "manufacturer_official",
      httpStatus: null,
      message: "official_product_page_not_discovered_v3",
    }),
  });

  assert.deepEqual(result, { status: "completed", outcome: "not_found" });
  assert.equal(retries.length, 0);
  assert.equal(acks.length, 1);
});

test("a verified candidate missing its primary category is not promoted", async () => {
  const db = sourceJobDatabase(1);
  const { message } = queueMessage({ target: CANDIDATE_TARGET });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message, {
    createVerifier: stubVerifier({
      status: "verified",
      sourceUrl: "https://www.luxman.co.jp/product/l-509z/",
      sourceType: "manufacturer_official",
      httpStatus: 200,
      canonicalModel: "L-509Z",
      canonicalName: "LUXMAN L-509Z",
      categoryIds: [],
      primaryCategoryId: "",
      contentHash: "",
      message: "verified_from_official_product_page_v2",
    } as unknown as KnowledgeSourceVerification),
  });

  assert.deepEqual(
    result,
    { status: "completed", outcome: "ambiguous" },
    "a catalog row without a primary category could not be displayed or rechecked",
  );
});

test("a malformed queue message is acked rather than redelivered forever", async () => {
  const db = queueDatabase();
  const { message, acks, retries } = queueMessage({ jobId: 0 });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.deepEqual(result, { status: "ignored", reason: "invalid_message" });
  assert.equal(acks.length, 1);
  assert.equal(retries.length, 0);
  assert.equal(db.statements.length, 0, "nothing is claimed for a message that cannot be routed");
});

test("a job another consumer already holds is acked without being processed", async () => {
  // Claiming is a conditional UPDATE; zero changed rows means the lease is held elsewhere.
  const db = queueDatabase((sql) =>
    sql.includes("SET status = 'processing'") ? { changes: 0 } : {},
  );
  const { message, acks, retries } = queueMessage();

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.deepEqual(result, { status: "ignored", reason: "job_not_claimable" });
  assert.equal(acks.length, 1);
  assert.equal(retries.length, 0);
  assert.equal(db.ran("SET status = 'retrying'").length, 0);
});

test("a busy manufacturer domain defers the job instead of fetching alongside another", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("knowledge_catalog_verification_domain_leases") && sql.includes("INSERT")) {
      return { changes: 0 };
    }
    if (sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")) {
      return { row: knowledgeJobRow() };
    }
    return {};
  });
  const { message, acks, retries } = queueMessage();

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.deepEqual(result, {
    status: "retrying",
    reason: "domain_busy",
    hostname: "www.luxman.co.jp",
  });
  assert.equal(acks.length, 0);
  assert.equal(retries[0]?.delaySeconds, 60);
  assert.equal(db.ran("SET status = 'retrying'").length, 1);
  assert.equal(
    db.ran("source_attempts = source_attempts + 1").length,
    0,
    "a deferred job has not read the source, so it must not spend an attempt",
  );
});

test("a job that fails while holding a domain lease still releases it", async () => {
  const db = queueDatabase((sql) =>
    sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")
      ? { row: knowledgeJobRow() }
      : {},
  );
  // A candidate message with no target throws inside the leased section.
  const { message, acks, retries } = queueMessage({ target: undefined });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.deepEqual(result, { status: "retrying", reason: "consumer_error" });
  assert.equal(
    db.ran("DELETE FROM knowledge_catalog_verification_domain_leases").length,
    1,
    "a lease that outlived its job would block the whole manufacturer until it expired",
  );
  assert.equal(retries.length, 1);
  assert.equal(acks.length, 0);
});

test("a job that has exhausted its delivery budget is dead-lettered, not retried", async () => {
  const db = queueDatabase((sql) =>
    sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")
      ? { row: knowledgeJobRow({ delivery_attempts: 99 }) }
      : {},
  );
  const { message, acks, retries } = queueMessage({ target: undefined });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.deepEqual(result, { status: "dead_letter", reason: "consumer_error_exhausted" });
  assert.equal(db.ran("SET status = 'dead_letter'").length, 1);
  assert.equal(retries.length, 0);
  assert.equal(acks.length, 1, "a dead-lettered job is acked so the queue stops redelivering it");
});

test("finalization waits while verification jobs are still outstanding", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")) {
      return { row: knowledgeJobRow({ job_type: "finalize", target_id: null, hostname: "" }) };
    }
    if (sql.includes("COUNT(*) AS target_jobs")) return { row: { target_jobs: 5, retrying: 2 } };
    return {};
  });
  const { message, acks, retries } = queueMessage({ jobType: "finalize" });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.equal(result.status, "retrying");
  assert.equal("reason" in result && result.reason, "verification_jobs_outstanding");
  assert.equal(retries[0]?.delaySeconds, 300);
  assert.equal(acks.length, 0);
  assert.equal(
    db.ran("UPDATE knowledge_catalog_review_runs").length,
    0,
    "a run reported as finished while work remains would publish partial results",
  );
});

test("finalization completes the run and the verifier rollout once nothing is outstanding", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")) {
      return { row: knowledgeJobRow({ job_type: "finalize", target_id: null, hostname: "" }) };
    }
    if (sql.includes("COUNT(*) AS target_jobs")) {
      return { row: { target_jobs: 2, completed: 2, promoted: 1, source_attempts: 2 } };
    }
    return {};
  });
  const { message, acks, retries } = queueMessage({ jobType: "finalize", verifierVersion: 5 });

  const result = await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.equal(result.status, "success");
  assert.equal("verifiedPromotions" in result && result.verifiedPromotions, 1);
  assert.equal(acks.length, 1);
  assert.equal(retries.length, 0);
  assert.equal(db.ran("UPDATE knowledge_catalog_verifier_state").length, 1);
  assert.equal(db.ran("SET status = 'completed'").length, 1);
});

test("a rollout is only recorded as finished when its version was claimed", async () => {
  const db = queueDatabase((sql) => {
    if (sql.includes("SELECT * FROM knowledge_catalog_verification_jobs")) {
      return { row: knowledgeJobRow({ job_type: "finalize", target_id: null, hostname: "" }) };
    }
    if (sql.includes("COUNT(*) AS target_jobs")) return { row: { target_jobs: 1, completed: 1 } };
    return {};
  });
  const { message } = queueMessage({ jobType: "finalize", verifierVersion: 0 });

  await consumeKnowledgeCatalogVerificationMessage(queueEnv(db), message);

  assert.equal(
    db.ran("UPDATE knowledge_catalog_verifier_state").length,
    0,
    "an ordinary run must not close out a rollout it never started",
  );
});

test("a dead-lettered finalizer fails its run so a rollout never looks stuck as running", async () => {
  const db = queueDatabase();
  const { message, acks } = queueMessage({ jobType: "finalize", verifierVersion: 5 });

  await consumeKnowledgeCatalogVerificationDeadLetterBatch(queueEnv(db), deadLetterBatch(message));

  assert.equal(db.ran("SET status = 'dead_letter'").length, 1);
  assert.equal(db.ran("UPDATE knowledge_catalog_review_runs").length, 1);
  assert.equal(db.ran("UPDATE knowledge_catalog_verifier_state").length, 1);
  assert.equal(acks.length, 1);
});

test("a dead-lettered target job is recorded without failing the whole run", async () => {
  const db = queueDatabase();
  const { message, acks } = queueMessage({ jobType: "candidate" });

  await consumeKnowledgeCatalogVerificationDeadLetterBatch(queueEnv(db), deadLetterBatch(message));

  assert.equal(db.ran("SET status = 'dead_letter'").length, 1);
  assert.equal(
    db.ran("UPDATE knowledge_catalog_review_runs").length,
    0,
    "one unreachable manufacturer must not fail the run its finalizer will still complete",
  );
  assert.equal(acks.length, 1);
});
