import assert from "node:assert/strict";
import { test } from "vite-plus/test";

import { meta } from "../src/http/meta.js";

test("public metadata redacts persisted crawler error text from sync and health projections", async () => {
  const secretError =
    "upstream failed at https://internal.example.test/private?token=super-secret host=10.0.0.7";
  const state = {
    shop_key: "hifido",
    last_attempt_at: "2026-08-11T06:00:00.000Z",
    last_success_at: "2026-08-11T05:59:00.000Z",
    last_error_at: "2026-08-11T06:00:00.000Z",
    consecutive_failures: 1,
    backoff_until: null,
    last_error: secretError,
    last_item_count: 10,
    queued_at: null,
  };
  const db = {
    prepare(sql: string) {
      return {
        async all() {
          return {
            results: sql.includes("public_meta_snapshot")
              ? [
                  {
                    generated_at: "2026-08-11T06:00:00.000Z",
                    payload_json: JSON.stringify(
                      Array.from({ length: 4 }, () => ({ results: [] })),
                    ),
                  },
                ]
              : [state],
          };
        },
      };
    },
    async batch() {
      return [{ results: [] }, { results: [] }];
    },
  };

  const response = await meta({ DB: db } as unknown as Env);
  const hifido = response.shops.find((shop) => shop.key === "hifido");

  assert.ok(hifido);
  assert.equal(hifido.sync?.last_error, null);
  assert.equal(hifido.health?.lastError, null);
  assert.doesNotMatch(
    JSON.stringify(response),
    /super-secret|internal\.example\.test|10\.0\.0\.7/u,
  );
});
