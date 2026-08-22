import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";
import { captureDatabase } from "./helpers/d1.js";

test("malformed queue bodies are retried without throwing during route detection", async () => {
  let retries = 0;
  const batch = {
    queue: "hifiscout-crawl",
    messages: [
      {
        body: null,
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {} as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(retries, 1);
});

test("Product Audit export routing requires the complete cursor guard", async () => {
  let retries = 0;
  const batch = {
    queue: "hifiscout-product-audit-export",
    messages: [
      {
        body: {
          kind: "product_audit_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {} as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(retries, 1);
});

test("Knowledge Catalog export routing requires the complete cursor guard", async () => {
  let retries = 0;
  const batch = {
    queue: "hifiscout-product-audit-export",
    messages: [
      {
        body: {
          kind: "knowledge_catalog_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {} as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(retries, 1);
});

test("Knowledge Catalog exports use the existing serialized main queue", async () => {
  let acknowledgements = 0;
  let retries = 0;
  const batch = {
    queue: "hifiscout-product-audit-export",
    messages: [
      {
        body: {
          kind: "knowledge_catalog_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
          expectedAfterId: 0,
          expectedChunkCount: 0,
        },
        ack() {
          acknowledgements += 1;
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {
    DB: captureDatabase(),
    EVIDENCE_BUCKET: {},
    PRODUCT_AUDIT_EXPORT_QUEUE: { async send() {} },
  } as unknown as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
});

test("Knowledge Catalog exports use the existing serialized dead-letter queue", async () => {
  let acknowledgements = 0;
  let retries = 0;
  const batch = {
    queue: "hifiscout-product-audit-export-dlq",
    messages: [
      {
        body: {
          kind: "knowledge_catalog_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
          expectedAfterId: 0,
          expectedChunkCount: 0,
        },
        ack() {
          acknowledgements += 1;
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {
    DB: captureDatabase(),
    EVIDENCE_BUCKET: {},
    PRODUCT_AUDIT_EXPORT_QUEUE: { async send() {} },
  } as unknown as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(acknowledgements, 1);
  assert.equal(retries, 0);
});

test("Product Audit messages cannot be misrouted to the Knowledge Catalog consumer", async () => {
  let retries = 0;
  const batch = {
    queue: "hifiscout-knowledge-verification",
    messages: [
      {
        body: {
          kind: "product_audit_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
          expectedAfterId: 0,
          expectedChunkCount: 0,
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {} as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(retries, 1);
});

test("Knowledge Catalog export messages cannot be misrouted to the verifier consumer", async () => {
  let retries = 0;
  const batch = {
    queue: "hifiscout-knowledge-verification",
    messages: [
      {
        body: {
          kind: "knowledge_catalog_export",
          jobId: "018fd28e-8af7-7be8-8e78-677cf30d888b",
          expectedAfterId: 0,
          expectedChunkCount: 0,
        },
        retry() {
          retries += 1;
        },
      },
    ],
  } as unknown as Parameters<typeof worker.queue>[0];
  const env = {} as Parameters<typeof worker.queue>[1];

  await worker.queue(batch, env);

  assert.equal(retries, 1);
});
