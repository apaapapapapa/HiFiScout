import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import {
  decodeObservation,
  encodeObservation,
  observationHours,
  observationKey,
  observationQuery,
  parseObservation,
  redactSql,
  SQL_OBSERVATION_BUCKET,
  SQL_OBSERVATION_GROUP_LIMIT,
  SQL_OBSERVATION_MAX_BYTES,
  SQL_OBSERVATION_MAX_JSON_BYTES,
  SQL_SORTS,
  summarizeObservations,
} from "../scripts/lib/d1-sql-observation.js";
import {
  archiveSqlObservations,
  SqlObservationClient,
} from "../scripts/lib/d1-sql-observation-client.js";

const ACCOUNT = "a".repeat(32);
const DATABASE = "11111111-1111-1111-1111-111111111111";
const VERSION = "22222222-2222-2222-2222-222222222222";
const AT = new Date("2026-09-06T01:23:00.000Z");
const HOUR = "2026-09-06T01:00:00.000Z";
const context = {
  databaseId: DATABASE,
  worker: "hifiscout",
  windowStart: HOUR,
  collectedAt: AT.toISOString(),
  deploymentVersions: [VERSION],
  collectorCommit: null,
};
function row(query: string, read = 100, write = 5, count = 2) {
  return {
    dimensions: { query },
    count,
    sum: { rowsRead: read, rowsWritten: write, rowsReturned: 2, queryDurationMs: 4 },
  };
}
function payload(rows = [row("SELECT * FROM products WHERE id = ?")]) {
  return {
    data: { viewer: { accounts: [Object.fromEntries(SQL_SORTS.map((sort) => [sort, rows]))] } },
  };
}

test("SQL redaction removes literals, blobs, comments, quoted identifiers and bound ordinals", () => {
  const sql =
    "SELECT secret_v2, 'Alice''s token', \"private\"\"value\", `hidden`, [mail], X'012aff', 0x12, .5e+2, 123 FROM t WHERE id=?17 -- api-key\r\n AND n = -1 /* note */";
  assert.equal(
    redactSql(sql),
    "SELECT secret_v2, ?, ?, ?, ?, ?, ?, ?, ? FROM t WHERE id=? AND n = -?",
  );
  assert.equal(
    redactSql("SELECT 1_234, 0xDE_AD, 1_2.3_4e+5_6, .1_2, 1.e2, column_123 FROM t"),
    "SELECT ?, ?, ?, ?, ?, column_123 FROM t",
  );
});

test("unterminated and multi-line tokens cannot leak their remainder", () => {
  for (const literal of [
    "'private\nvalue",
    '"private value',
    "`private",
    "[private",
    "/* private",
    "-- private",
  ]) {
    assert.doesNotMatch(redactSql(`SELECT ${literal}`), /private|value/);
  }
  assert.equal(redactSql("SELECT 'こんにちは', 'a\\b', '2026-09-06'"), "SELECT ?, ?, ?");
});

test("four rankings are deduplicated before literal variants merge, and values are never fingerprinted", () => {
  const archive = parseObservation(
    payload([
      row("SELECT * FROM products WHERE id=123"),
      row("SELECT * FROM products WHERE id=456"),
    ]),
    context,
  );
  assert.equal(archive.queries.length, 1);
  assert.equal(archive.coverage.sourceQueryGroups, 2);
  assert.equal(archive.queries[0]?.variants, 2);
  assert.equal(archive.totals.rowsRead, 200);
  assert.equal(archive.totals.rowsWritten, 10);
  assert.equal(archive.totals.count, 4);
  assert.equal(archive.queries[0]?.rowsRead, 200);
  assert.equal(archive.queries[0]?.sql, "SELECT * FROM products WHERE id=?");
  const other = parseObservation(payload([row("SELECT * FROM products WHERE id=999")]), context);
  assert.equal(archive.queries[0]?.fingerprint, other.queries[0]?.fingerprint);
});

test("missing metrics stay unknown; bad/missing API data never becomes a success with zero cost", () => {
  const missing = payload();
  missing.data.viewer.accounts[0]!.reads = [
    { dimensions: { query: "SELECT 1" }, count: 1, sum: {} } as ReturnType<typeof row>,
  ];
  const archive = parseObservation(missing, context);
  assert.equal(archive.totals.rowsRead, null);
  for (const invalid of [
    {},
    { data: { viewer: { accounts: [] } } },
    { errors: [{ message: "private-token" }], ...payload() },
    payload([row("SELECT 1", -1)]),
  ]) {
    assert.throws(
      () => parseObservation(invalid, context),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.doesNotMatch(error.message, /private-token/);
        return true;
      },
    );
  }
});

test("ranking saturation and inconsistent copies remain visible without double-counting", () => {
  const source = payload(
    Array.from({ length: SQL_OBSERVATION_GROUP_LIMIT }, (_, i) => row(`SELECT ${i}`)),
  );
  source.data.viewer.accounts[0]!.writes![0] = row("SELECT 0", 999);
  // Use independent arrays to simulate a differing alias, rather than changing all aliases.
  source.data.viewer.accounts[0]!.reads = Array.from(
    { length: SQL_OBSERVATION_GROUP_LIMIT },
    (_, i) => row(`SELECT ${i}`),
  );
  const result = parseObservation(source, context);
  assert.deepEqual(result.coverage.limitHitBy, [...SQL_SORTS]);
  assert.ok(result.coverage.inconsistentGroups > 0);
  assert.equal(result.totals.rowsRead, SQL_OBSERVATION_GROUP_LIMIT * 100);
});

test("UTC windows cross days and each hour has a stable non-overlapping R2 key", () => {
  assert.deepEqual(observationHours(new Date("2026-09-06T00:08:00Z")), [
    "2026-09-05T22:00:00.000Z",
    "2026-09-05T23:00:00.000Z",
    "2026-09-06T00:00:00.000Z",
  ]);
  assert.equal(observationKey(DATABASE, HOUR), `sql/v1/${DATABASE}/2026-09-06/01.json.gz`);
  for (const count of [0, 25, NaN, 1.2]) assert.throws(() => observationHours(AT, count));
  assert.throws(() => observationKey("../../invalid", HOUR));
  assert.throws(() => observationKey(DATABASE, "2026-09-06T01:01:00.000Z"));
});

test("native D1 query filters do not reuse another dataset's nominal GraphQL input type", () => {
  const query = observationQuery(DATABASE, HOUR);
  assert.match(query, /\$accountTag: string!/);
  assert.doesNotMatch(query, /\$filter|ZoneWorkersRequestsFilter_InputObject/);
  assert.equal(
    query.split(
      `filter: {databaseId: "${DATABASE}", datetimeHour_geq: "${HOUR}", datetimeHour_leq: "${HOUR}"}`,
    ).length - 1,
    SQL_SORTS.length,
  );
  assert.throws(() => observationQuery('"} injection', HOUR));
  assert.throws(() => observationQuery(DATABASE, '"} injection'));
});

test("large archives are bounded, omitted groups are counted and totals are retained", () => {
  const queries = Array.from({ length: SQL_OBSERVATION_GROUP_LIMIT }, (_, i) =>
    row(`SELECT column_${i}_${randomBytes(12_000).toString("hex")} FROM t`),
  );
  const initial = parseObservation(payload(queries), context);
  const encoded = encodeObservation(initial);
  assert.ok(encoded.bytes.length <= SQL_OBSERVATION_MAX_BYTES);
  assert.ok(gunzipSync(encoded.bytes).length <= SQL_OBSERVATION_MAX_JSON_BYTES);
  assert.ok(encoded.observation.coverage.omittedQueryGroups > 0);
  assert.deepEqual(encoded.observation.totals, initial.totals);
  assert.equal(initial.coverage.omittedQueryGroups, 0, "encoding does not mutate caller data");
  assert.deepEqual(decodeObservation(encoded.bytes), encoded.observation);
  assert.throws(() => decodeObservation(gzipSync("{}")));
  assert.throws(() => decodeObservation(gzipSync("x".repeat(SQL_OBSERVATION_MAX_JSON_BYTES + 1))));
});

test("analysis chooses the newest snapshot per hour and sums disjoint hours only", () => {
  const older = parseObservation(payload(), context);
  const newer = parseObservation(payload([row("SELECT * FROM products WHERE id = ?", 150)]), {
    ...context,
    collectedAt: "2026-09-06T01:40:00.000Z",
  });
  const priorHour = parseObservation(payload(), {
    ...context,
    windowStart: "2026-09-06T00:00:00.000Z",
  });
  const report = summarizeObservations([newer, older, priorHour]);
  assert.equal(report.hours.length, 2);
  assert.equal(report.totals.rowsRead, 250);
  assert.equal(report.topReads[0]?.rowsRead, 250);
  assert.equal(newer.queries[0]?.rowsRead, 150, "summarization does not mutate archived data");
  assert.throws(() => summarizeObservations([older, { ...older, databaseId: VERSION }]));
});

function fakeCloudflare(
  options: {
    denied?: boolean;
    corruptReadBack?: boolean;
    badLifecycle?: boolean;
    previousRetentionDays?: number;
  } = {},
) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const objects = new Map<string, Uint8Array>();
  let exists = false;
  let rules: unknown[] = [{ id: "operator", enabled: true, conditions: { prefix: "other/" } }];
  if (options.previousRetentionDays)
    rules.push({
      id: "hifiscout-d1-sql-observations",
      enabled: true,
      conditions: { prefix: "sql/v1/" },
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: options.previousRetentionDays * 86400 },
      },
    });
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    const method = init?.method ?? "GET";
    const body: unknown = typeof init?.body === "string" ? JSON.parse(init.body) : init?.body;
    calls.push({ path, method, body });
    assert.equal(url.origin, "https://api.cloudflare.com");
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer configured-token");
    assert.equal(init?.redirect, "error");
    assert.doesNotMatch(path, /\/d1\/database\/.*\/(query|raw|import|export)/);
    const success = (result: unknown) => Response.json({ success: true, result });
    if (options.denied) return Response.json({ private: "DO-NOT-LOG" }, { status: 403 });
    if (path.endsWith("/settings"))
      return success({ bindings: [{ name: "DB", type: "d1", id: DATABASE }] });
    if (path.endsWith("/deployments"))
      return success({ deployments: [{ versions: [{ version_id: VERSION }] }] });
    if (path.endsWith("/graphql"))
      return Response.json(
        payload([row("SELECT * FROM t WHERE secret='DO-NOT-STORE' AND id=123")]),
      );
    if (path.endsWith(`/r2/buckets/${SQL_OBSERVATION_BUCKET}`))
      return exists ? success({}) : new Response(null, { status: 404 });
    if (path.endsWith("/r2/buckets") && method === "POST") {
      exists = true;
      return success({});
    }
    if (path.endsWith("/lifecycle")) {
      if (method === "PUT") rules = (body as { rules: unknown[] }).rules;
      return success(options.badLifecycle ? {} : { rules });
    }
    if (path.includes("/objects/")) {
      if (method === "PUT") {
        assert.ok(body instanceof Uint8Array);
        assert.equal(new Headers(init?.headers).get("content-type"), "application/gzip");
        assert.equal(new Headers(init?.headers).get("cache-control"), "private, no-store");
        assert.doesNotMatch(gunzipSync(body).toString(), /DO-NOT-STORE|configured-token/);
        objects.set(path, body);
        return new Response(null, { status: 204 });
      }
      const bytes = objects.get(path);
      if (options.corruptReadBack) return new Response(gzipSync("{}"));
      return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected mock route ${path}`);
  };
  return {
    client: new SqlObservationClient({
      accountId: ACCOUNT,
      apiToken: "configured-token",
      fetchImpl,
    }),
    calls,
    objects,
    rules: () => rules,
  };
}

test("complete collection provisions private retention, archives three hours and verifies R2 without D1 queries", async () => {
  const fake = fakeCloudflare();
  const result = await archiveSqlObservations(fake.client, { at: AT });
  assert.equal(result.retentionDays, 5);
  assert.equal(fake.objects.size, 3);
  assert.equal(result.saved.length, 3);
  assert.doesNotMatch(JSON.stringify(result), /SELECT|DO-NOT-STORE/);
  assert.equal(fake.calls.filter((call) => call.path.endsWith("/graphql")).length, 3);
  const graphqlCalls = fake.calls.filter((call) => call.path.endsWith("/graphql"));
  for (const [i, hour] of observationHours(AT).entries()) {
    const body = graphqlCalls[i]?.body as { query: string; variables: unknown };
    assert.equal(body.query, observationQuery(DATABASE, hour));
    assert.deepEqual(body.variables, { accountTag: ACCOUNT });
  }
  assert.equal(fake.rules().length, 2);
  assert.equal((fake.rules()[0] as { id: string }).id, "operator");
  assert.deepEqual(fake.rules()[1], {
    id: "hifiscout-d1-sql-observations",
    enabled: true,
    conditions: { prefix: "sql/v1/" },
    deleteObjectsTransition: { condition: { type: "Age", maxAge: 5 * 86400 } },
  });
  await archiveSqlObservations(fake.client, { at: new Date("2026-09-06T01:38:00Z") });
  assert.equal(fake.objects.size, 3, "late snapshots replace hours instead of growing storage");
  assert.equal(
    fake.calls.filter((call) => call.method === "PUT" && call.path.endsWith("/lifecycle")).length,
    1,
  );
  assert.equal(
    fake.calls.filter((call) => call.method === "POST" && call.path.endsWith("/r2/buckets")).length,
    1,
  );
});

test("existing SQL retention is reconciled to five days without changing unrelated rules", async () => {
  const fake = fakeCloudflare({ previousRetentionDays: 30 });
  await fake.client.ensureArchiveStorage();
  assert.equal(fake.rules().length, 2);
  assert.deepEqual(fake.rules()[0], {
    id: "operator",
    enabled: true,
    conditions: { prefix: "other/" },
  });
  assert.equal(
    (fake.rules()[1] as { deleteObjectsTransition: { condition: { maxAge: number } } })
      .deleteObjectsTransition.condition.maxAge,
    432000,
  );
});

test("historical recollection records the actual collection time, not the selected hour", async () => {
  const fake = fakeCloudflare();
  const collectedAt = new Date("2026-09-07T05:12:00Z");
  const result = await archiveSqlObservations(fake.client, { at: AT, hours: 1, collectedAt });
  assert.equal(result.collectedAt, collectedAt.toISOString());
  assert.equal((await fake.client.load(DATABASE, HOUR))?.collectedAt, collectedAt.toISOString());
  assert.equal(result.saved[0]?.windowStart, HOUR);
});

test("permissions, malformed lifecycle and corrupt read-back fail closed without fallback credentials", async () => {
  const denied = fakeCloudflare({ denied: true });
  await assert.rejects(archiveSqlObservations(denied.client, { at: AT }), /HTTP 403/);
  assert.equal(denied.calls.length, 1);
  assert.equal(denied.objects.size, 0);
  const lifecycle = fakeCloudflare({ badLifecycle: true });
  await assert.rejects(archiveSqlObservations(lifecycle.client, { at: AT }), /lifecycle/);
  assert.equal(lifecycle.calls.filter((call) => call.method === "PUT").length, 0);
  await assert.rejects(
    archiveSqlObservations(fakeCloudflare({ corruptReadBack: true }).client, { at: AT }),
    /Invalid SQL observation archive/,
  );
});

test("an explicit archived database can be read while all live settings and D1 APIs are unused", async () => {
  const fake = fakeCloudflare();
  await archiveSqlObservations(fake.client, { at: AT, hours: 1 });
  fake.calls.length = 0;
  const archive = await fake.client.load(DATABASE, HOUR);
  assert.equal(archive?.databaseId, DATABASE);
  assert.equal(fake.calls.length, 1);
  assert.ok(fake.calls[0]?.path.includes("/objects/"));
  assert.equal(await fake.client.load(DATABASE, "2026-09-05T01:00:00.000Z"), null);
});

test("passive scheduled collection does not enable active data-platform health jobs", () => {
  const workflow = readFileSync(
    new URL("../.github/workflows/production-operational-health.yml", import.meta.url),
    "utf8",
  );
  assert.match(workflow, /cron: "8,23,38,53 \* \* \* \*"/);
  const archive = workflow.slice(
    workflow.indexOf("  d1-sql-archive:"),
    workflow.indexOf("  data-platform:"),
  );
  assert.match(archive, /scripts\/archive-d1-sql.ts/);
  assert.doesNotMatch(
    archive,
    /name: deployment-identity|d1 execute|wait-for-active-crawl-convergence/,
  );
  for (const name of ["data-platform", "knowledge-catalog"]) {
    assert.match(
      workflow,
      new RegExp(
        `${name}:\\n    if: github.event_name == 'workflow_dispatch' \\|\\| github.event.workflow_run.conclusion == 'success'`,
      ),
    );
  }
});
