import test from "node:test";
import assert from "node:assert/strict";

import worker from "../src/index.js";

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
