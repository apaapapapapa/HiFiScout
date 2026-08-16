import type { QueryableDatabase } from "../../src/db/types.js";

type RestParameter = string | number | null;

interface RestStatementRequest {
  sql: string;
  params: RestParameter[];
}

interface CloudflareApiError {
  code?: number;
  message?: string;
}

interface CloudflareD1Envelope {
  success?: boolean;
  result?: unknown;
  errors?: CloudflareApiError[];
}

export interface D1RestDatabaseOptions {
  accountId: string;
  databaseId: string;
  apiToken: string;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number) => Promise<void>;
  maxRateLimitRetries?: number;
}

function normalizeParameter(value: unknown): RestParameter {
  if (value === null || typeof value === "string" || typeof value === "number") return value;
  if (typeof value === "boolean") return value ? 1 : 0;
  throw new TypeError(`D1 REST adapter does not support bind value type: ${typeof value}`);
}

function errorSummary(envelope: CloudflareD1Envelope | null): string {
  const errors = envelope?.errors || [];
  if (!errors.length) return "Cloudflare D1 API returned an unsuccessful response";
  return errors
    .map((error) => [error.code, error.message].filter((part) => part != null && part !== "").join(": "))
    .join("; ");
}

function rateLimitDelay(response: Response, attempt: number): number {
  const retryAfter = response.headers.get("retry-after");
  const retrySeconds = retryAfter == null ? Number.NaN : Number(retryAfter);
  if (Number.isFinite(retrySeconds) && retrySeconds >= 0) {
    return Math.max(250, retrySeconds * 1000);
  }
  return Math.min(5_000, 500 * 2 ** attempt);
}

function asStatementResults(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  return value == null ? [] : [value];
}

class D1RestPreparedStatement {
  constructor(
    private readonly database: D1RestDatabase,
    readonly sql: string,
    readonly params: readonly RestParameter[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1RestPreparedStatement(
      this.database,
      this.sql,
      values.map(normalizeParameter),
    ) as unknown as D1PreparedStatement;
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.database.execute<T>({ sql: this.sql, params: [...this.params] });
    const row = result.results?.[0];
    if (row == null) return null;
    if (!columnName) return row;
    if (typeof row !== "object") return null;
    return ((row as Record<string, unknown>)[columnName] ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>({ sql: this.sql, params: [...this.params] });
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>({ sql: this.sql, params: [...this.params] });
  }

  async raw<T extends unknown[] = unknown[]>(options: { columnNames?: boolean } = {}): Promise<T[]> {
    const result = await this.database.execute<Record<string, unknown>>({
      sql: this.sql,
      params: [...this.params],
    });
    const rows = result.results || [];
    if (!rows.length) return [];
    const columns = Object.keys(rows[0] || {});
    const values = rows.map((row) => columns.map((column) => row[column]) as T);
    if (!options.columnNames) return values;
    return [columns as unknown as T, ...values];
  }
}

export class D1RestDatabase implements QueryableDatabase {
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (milliseconds: number) => Promise<void>;
  private readonly maxRateLimitRetries: number;
  private readonly endpoint: string;

  constructor(private readonly options: D1RestDatabaseOptions) {
    this.fetchImpl = options.fetchImpl || fetch;
    this.sleep = options.sleep || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? 4);
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
  }

  prepare(sql: string): D1PreparedStatement {
    return new D1RestPreparedStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const requests = statements.map((statement) => {
      if (!(statement instanceof D1RestPreparedStatement)) {
        throw new TypeError("D1 REST batch received a statement from a different database adapter");
      }
      return { sql: statement.sql, params: [...statement.params] };
    });
    return this.request<T>({ batch: requests }, requests.length);
  }

  async execute<T>(statement: RestStatementRequest): Promise<D1Result<T>> {
    const results = await this.request<T>(statement, 1);
    const first = results[0];
    if (!first) throw new Error("Cloudflare D1 API returned no statement result");
    return first;
  }

  private async request<T>(
    body: RestStatementRequest | { batch: RestStatementRequest[] },
    expectedResults: number,
  ): Promise<D1Result<T>[]> {
    for (let attempt = 0; ; attempt += 1) {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      if (response.status === 429 && attempt < this.maxRateLimitRetries) {
        await this.sleep(rateLimitDelay(response, attempt));
        continue;
      }

      const text = await response.text();
      let envelope: CloudflareD1Envelope | null = null;
      if (text) {
        try {
          envelope = JSON.parse(text) as CloudflareD1Envelope;
        } catch {
          envelope = null;
        }
      }

      if (!response.ok) {
        throw new Error(
          `Cloudflare D1 API request failed with HTTP ${response.status}: ${errorSummary(envelope)}`,
        );
      }
      if (!envelope?.success) throw new Error(errorSummary(envelope));

      const results = asStatementResults(envelope.result) as D1Result<T>[];
      if (results.length !== expectedResults) {
        throw new Error(
          `Cloudflare D1 API result count mismatch: expected ${expectedResults}, received ${results.length}`,
        );
      }
      return results;
    }
  }
}

export function createD1RestDatabase(options: D1RestDatabaseOptions): QueryableDatabase {
  return new D1RestDatabase(options);
}
