import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import type { EnvSecretName } from "../src/crawler/types.js";

/**
 * Workers Free accepts at most 64 variables per Worker, counting secrets and text `vars` together.
 * An oversized set is rejected by the upload (Cloudflare error 10055) after D1 migrations have
 * already been applied, so the cap is checked before merge rather than discovered by a deploy.
 */
const WORKERS_FREE_VARIABLE_LIMIT = 64;

/** A record, so adding a secret to {@link EnvSecretName} without counting it here fails typecheck. */
const DEPLOYED_SECRETS: Readonly<Record<EnvSecretName, true>> = {
  CRAWL_RELAY_URL: true,
  CRAWL_RELAY_TOKEN: true,
};

test("the public Worker's variables and secrets fit the Workers Free cap", () => {
  const config = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as {
    vars?: Record<string, unknown>;
  };
  const total = Object.keys(config.vars ?? {}).length + Object.keys(DEPLOYED_SECRETS).length;
  assert.ok(
    total <= WORKERS_FREE_VARIABLE_LIMIT,
    `${total} variables exceed ${WORKERS_FREE_VARIABLE_LIMIT}; declare only values that differ from code defaults`,
  );
});
