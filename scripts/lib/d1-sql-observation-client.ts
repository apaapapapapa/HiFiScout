import { isDeepStrictEqual } from "node:util";
import {
  checkedIdentifier,
  decodeObservation,
  encodeObservation,
  object,
  observationHours,
  observationKey,
  observationQuery,
  parseObservation,
  SQL_OBSERVATION_BUCKET,
  SQL_OBSERVATION_MAX_BYTES,
  SQL_OBSERVATION_PREFIX,
  SQL_OBSERVATION_RETENTION_DAYS,
  SqlObservationError,
  type SqlObservation,
} from "./d1-sql-observation.js";

const API = "https://api.cloudflare.com/client/v4";
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const LIFECYCLE_ID = "hifiscout-d1-sql-observations";

export interface SqlObservationClientOptions {
  accountId: string;
  apiToken: string;
  worker?: string;
  fetchImpl?: typeof fetch;
}

/** Read bounded bodies; never include Cloudflare response bodies, SQL literals or tokens in errors. */
async function responseBytes(response: Response, limit = MAX_RESPONSE_BYTES): Promise<Buffer> {
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return Buffer.concat(chunks, length);
      length += value.byteLength;
      if (length > limit)
        throw new SqlObservationError("Cloudflare response exceeded the observation size bound.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function jsonResponse(response: Response): Promise<unknown> {
  const bytes = await responseBytes(response);
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new SqlObservationError(
      "Cloudflare returned invalid JSON. Response bodies are not logged.",
    );
  }
}

export class SqlObservationClient {
  readonly accountId: string;
  readonly worker: string;
  private readonly fetchImpl: typeof fetch;
  constructor(private readonly options: SqlObservationClientOptions) {
    this.accountId = checkedIdentifier(options.accountId, "account");
    this.worker = checkedIdentifier(options.worker ?? "hifiscout", "worker");
    if (!options.apiToken)
      throw new SqlObservationError("A configured Cloudflare API token is required.");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  private async request(
    path: string,
    init: RequestInit = {},
    allowMissing = false,
  ): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.options.apiToken}`);
    let response: Response;
    try {
      response = await this.fetchImpl(`${API}${path}`, {
        ...init,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new SqlObservationError(
        "Cloudflare observation request failed or timed out; no response bodies were logged.",
      );
    }
    if (!response.ok && !(allowMissing && response.status === 404)) {
      await response.body?.cancel();
      const hint =
        response.status === 401 || response.status === 403
          ? " Check the existing token's permissions; no fallback credentials are used."
          : "";
      throw new SqlObservationError(
        `Cloudflare observation request failed (HTTP ${response.status}).${hint}`,
      );
    }
    return response;
  }

  private accountPath(path: string): string {
    return `/accounts/${this.accountId}${path}`;
  }

  private async result(path: string, init: RequestInit = {}): Promise<unknown> {
    const payload = await jsonResponse(await this.request(this.accountPath(path), init));
    if (!object(payload) || payload.success !== true)
      throw new SqlObservationError("Cloudflare observation API did not confirm success.");
    return payload.result;
  }

  /** Resolve the ACTIVE Worker's binding, never guess a database by name or inspect its tables. */
  async activeTarget(): Promise<{ databaseId: string; deploymentVersions: string[] }> {
    const settings = await this.result(`/workers/scripts/${this.worker}/settings`);
    if (!object(settings) || !Array.isArray(settings.bindings))
      throw new SqlObservationError("Cloudflare returned invalid active Worker bindings.");
    const bindings = settings.bindings.filter(
      (binding) => object(binding) && binding.name === "DB" && binding.type === "d1",
    );
    const binding: unknown = bindings[0];
    if (bindings.length !== 1 || !object(binding) || typeof binding.id !== "string")
      throw new SqlObservationError("The active Worker must have exactly one DB D1 binding.");
    const databaseId = checkedIdentifier(binding.id, "database");
    const deployments = await this.result(`/workers/scripts/${this.worker}/deployments`);
    if (!object(deployments) || !Array.isArray(deployments.deployments))
      throw new SqlObservationError("Cloudflare returned invalid Worker deployments.");
    const current = deployments.deployments[0];
    if (!object(current) || !Array.isArray(current.versions) || current.versions.length > 10)
      throw new SqlObservationError("Cloudflare returned no current Worker deployment.");
    const deploymentVersions = current.versions.map((version: unknown) => {
      if (!object(version) || typeof version.version_id !== "string")
        throw new SqlObservationError("Invalid Worker version identity.");
      return checkedIdentifier(version.version_id, "database");
    });
    return { databaseId, deploymentVersions };
  }

  async collectHour(
    databaseId: string,
    hour: string,
    collectedAt: Date,
    deploymentVersions: string[],
    collectorCommit: string | null,
  ): Promise<SqlObservation> {
    observationKey(databaseId, hour);
    const payload = await jsonResponse(
      await this.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: observationQuery(databaseId, hour),
          operationName: "HiFiScoutD1SqlObservation",
          variables: { accountTag: this.accountId },
        }),
      }),
    );
    return parseObservation(payload, {
      databaseId,
      worker: this.worker,
      windowStart: hour,
      collectedAt: collectedAt.toISOString(),
      deploymentVersions,
      collectorCommit:
        collectorCommit && /^[a-f0-9]{40}$/.test(collectorCommit) ? collectorCommit : null,
    });
  }

  /** Passive Workers analytics, grouped only by status; no application request or SQL. */
  async workerStatusMetrics(
    worker: "hifiscout" | "hifiscout-admin",
    windowStart: string,
    windowEnd: string,
  ) {
    return jsonResponse(
      await this.request("/graphql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          query: `query AdminWorkerStatus($accountTag: string, $worker: string, $start: string, $end: string) {
        viewer { accounts(filter: {accountTag: $accountTag}) { workersInvocationsAdaptive(limit: 50,
          filter: {scriptName: $worker, datetime_geq: $start, datetime_lt: $end}) {
          dimensions { status } sum { requests errors }
        } } }
      }`,
          variables: { accountTag: this.accountId, worker, start: windowStart, end: windowEnd },
        }),
      }),
    );
  }

  async saveAdminSnapshot(kind: "sql-load" | "runtime", value: unknown): Promise<void> {
    const body = JSON.stringify(value);
    if (Buffer.byteLength(body) > 64 * 1024)
      throw new SqlObservationError("Admin snapshot exceeds its size bound.");
    const path = this.accountPath(
      `/r2/buckets/${SQL_OBSERVATION_BUCKET}/objects/admin/v1/${kind}.json`,
    );
    const saved = await this.request(path, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        "cf-r2-data-catalog-check": "true",
      },
      body,
    });
    await saved.body?.cancel();
    const readBack = await jsonResponse(await this.request(path));
    if (!isDeepStrictEqual(readBack, value))
      throw new SqlObservationError("Admin snapshot read-back mismatch.");
  }

  /** Dedicated bucket, private on creation; never enables a public domain or grants access.
   * Only our named prefix policy is managed; unrelated lifecycle rules remain byte-for-byte. */
  async ensureArchiveStorage(): Promise<void> {
    const bucketPath = `/r2/buckets/${SQL_OBSERVATION_BUCKET}`;
    const bucket = await this.request(this.accountPath(bucketPath), {}, true);
    const missing = bucket.status === 404;
    await bucket.body?.cancel();
    if (missing)
      await this.result("/r2/buckets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: SQL_OBSERVATION_BUCKET }),
      });
    const lifecycle = await this.result(`${bucketPath}/lifecycle`);
    if (
      !object(lifecycle) ||
      !Array.isArray(lifecycle.rules) ||
      !lifecycle.rules.every((rule) => object(rule) && typeof rule.id === "string")
    )
      throw new SqlObservationError("Invalid R2 lifecycle response; refusing to overwrite it.");
    const desired = {
      id: LIFECYCLE_ID,
      enabled: true,
      conditions: { prefix: SQL_OBSERVATION_PREFIX },
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: SQL_OBSERVATION_RETENTION_DAYS * 86400 },
      },
    };
    const existing = lifecycle.rules.find((rule) => rule.id === LIFECYCLE_ID);
    if (isDeepStrictEqual(existing, desired)) return;
    const rules = lifecycle.rules.filter((rule) => rule.id !== LIFECYCLE_ID);
    rules.push(desired);
    await this.result(`${bucketPath}/lifecycle`, {
      method: "PUT",
      headers: { "content-type": "application/json", "cf-r2-data-catalog-check": "true" },
      body: JSON.stringify({ rules }),
    });
  }

  async save(
    observation: SqlObservation,
  ): Promise<{ key: string; bytes: number; queries: number; omitted: number }> {
    const key = observationKey(observation.databaseId, observation.windowStart);
    const encoded = encodeObservation(observation);
    const response = await this.request(
      this.accountPath(`/r2/buckets/${SQL_OBSERVATION_BUCKET}/objects/${key}`),
      {
        method: "PUT",
        headers: {
          "content-type": "application/gzip",
          "cache-control": "private, no-store",
          "cf-r2-data-catalog-check": "true",
        },
        body: new Uint8Array(encoded.bytes),
      },
    );
    await response.body?.cancel();
    return {
      key,
      bytes: encoded.bytes.length,
      queries: encoded.observation.queries.length,
      omitted: encoded.observation.coverage.omittedQueryGroups,
    };
  }

  async load(databaseId: string, hour: string): Promise<SqlObservation | null> {
    const key = observationKey(databaseId, hour);
    const response = await this.request(
      this.accountPath(`/r2/buckets/${SQL_OBSERVATION_BUCKET}/objects/${key}`),
      {},
      true,
    );
    if (response.status === 404) {
      await response.body?.cancel();
      return null;
    }
    const archive = decodeObservation(await responseBytes(response, SQL_OBSERVATION_MAX_BYTES));
    if (archive.databaseId !== databaseId || archive.windowStart !== hour)
      throw new SqlObservationError(
        "R2 SQL archive identity does not match the requested hour/database.",
      );
    return archive;
  }
}

export async function archiveSqlObservations(
  client: SqlObservationClient,
  {
    collectedAt = new Date(),
    at = collectedAt,
    hours = 3,
    collectorCommit = null,
  }: { at?: Date; collectedAt?: Date; hours?: number; collectorCommit?: string | null } = {},
) {
  const windows = observationHours(at, hours);
  if (!Number.isFinite(collectedAt.getTime()))
    throw new SqlObservationError("Use a valid collection timestamp.");
  const target = await client.activeTarget();
  // Verify native Insights access before provisioning storage. No SQL query is sent to D1.
  const observations: SqlObservation[] = [];
  for (const hour of windows)
    observations.push(
      await client.collectHour(
        target.databaseId,
        hour,
        collectedAt,
        target.deploymentVersions,
        collectorCommit,
      ),
    );
  await client.ensureArchiveStorage();
  const saved = [];
  for (const observation of observations) {
    const result = await client.save(observation);
    // Read back the persisted object, not merely a successful upload response.
    const persisted = await client.load(target.databaseId, observation.windowStart);
    if (!persisted || persisted.collectedAt !== observation.collectedAt)
      throw new SqlObservationError("SQL archive read-back did not confirm this snapshot.");
    saved.push({
      ...result,
      windowStart: observation.windowStart,
      coverage: persisted.coverage,
      totals: persisted.totals,
    });
  }
  return {
    bucket: SQL_OBSERVATION_BUCKET,
    retentionDays: SQL_OBSERVATION_RETENTION_DAYS,
    databaseId: target.databaseId,
    collectedAt: collectedAt.toISOString(),
    saved,
  };
}

/** Download/decompress bounded R2 objects; never execute SQL or recollect Insights. */
export async function loadSqlObservations(
  client: SqlObservationClient,
  {
    at = new Date(),
    hours = 6,
    databaseId,
  }: { at?: Date; hours?: number; databaseId?: string } = {},
) {
  const requestedHours = observationHours(at, hours);
  const target = checkedIdentifier(
    databaseId ?? (await client.activeTarget()).databaseId,
    "database",
  );
  const archives: SqlObservation[] = [];
  const missingHours: string[] = [];
  for (const hour of requestedHours) {
    const archive = await client.load(target, hour);
    if (archive) archives.push(archive);
    else missingHours.push(hour);
  }
  return { databaseId: target, requestedHours, archives, missingHours };
}
