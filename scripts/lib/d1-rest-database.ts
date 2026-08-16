import type { QueryableDatabase } from "../../src/db/types.js";

type BoundValue = string | number | boolean | null | ArrayBuffer;

interface RestStatementRequest {
  sql: string;
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

function normalizeBoundValue(value: unknown): BoundValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value instanceof ArrayBuffer
  ) {
    return value;
  }
  throw new TypeError(`D1 REST adapter does not support bind value type: ${typeof value}`);
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sqlLiteral(value: BoundValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      throw new TypeError("D1 REST adapter cannot bind a non-finite number");
    return String(value);
  }
  return `X'${hex(new Uint8Array(value))}'`;
}

function renderBoundSql(sql: string, values: readonly BoundValue[]): string {
  let output = "";
  let valueIndex = 0;
  let state: "normal" | "single" | "double" | "backtick" | "bracket" | "line" | "block" = "normal";

  for (let index = 0; index < sql.length; index += 1) {
    const current = sql[index] || "";
    const next = sql[index + 1] || "";

    if (state === "line") {
      output += current;
      if (current === "\n") state = "normal";
      continue;
    }
    if (state === "block") {
      output += current;
      if (current === "*" && next === "/") {
        output += next;
        index += 1;
        state = "normal";
      }
      continue;
    }
    if (state === "single") {
      output += current;
      if (current === "'" && next === "'") {
        output += next;
        index += 1;
      } else if (current === "'") {
        state = "normal";
      }
      continue;
    }
    if (state === "double") {
      output += current;
      if (current === '"' && next === '"') {
        output += next;
        index += 1;
      } else if (current === '"') {
        state = "normal";
      }
      continue;
    }
    if (state === "backtick") {
      output += current;
      if (current === "`" && next === "`") {
        output += next;
        index += 1;
      } else if (current === "`") {
        state = "normal";
      }
      continue;
    }
    if (state === "bracket") {
      output += current;
      if (current === "]") state = "normal";
      continue;
    }

    if (current === "-" && next === "-") {
      output += `${current}${next}`;
      index += 1;
      state = "line";
      continue;
    }
    if (current === "/" && next === "*") {
      output += `${current}${next}`;
      index += 1;
      state = "block";
      continue;
    }
    if (current === "'") {
      output += current;
      state = "single";
      continue;
    }
    if (current === '"') {
      output += current;
      state = "double";
      continue;
    }
    if (current === "`") {
      output += current;
      state = "backtick";
      continue;
    }
    if (current === "[") {
      output += current;
      state = "bracket";
      continue;
    }
    if (current === "?") {
      const value = values[valueIndex];
      if (valueIndex >= values.length || value === undefined) {
        throw new Error("D1 REST adapter received fewer bind values than SQL placeholders");
      }
      output += sqlLiteral(value);
      valueIndex += 1;
      continue;
    }
    output += current;
  }

  if (valueIndex !== values.length) {
    throw new Error(
      `D1 REST adapter bind count mismatch: SQL used ${valueIndex}, received ${values.length}`,
    );
  }
  return output;
}

function errorSummary(envelope: CloudflareD1Envelope | null): string {
  const errors = envelope?.errors || [];
  if (!errors.length) return "Cloudflare D1 API returned an unsuccessful response";
  return errors
    .map((error) =>
      [error.code, error.message].filter((part) => part != null && part !== "").join(": "),
    )
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
    readonly values: readonly BoundValue[] = [],
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new D1RestPreparedStatement(
      this.database,
      this.sql,
      values.map(normalizeBoundValue),
    ) as unknown as D1PreparedStatement;
  }

  request(): RestStatementRequest {
    return { sql: renderBoundSql(this.sql, this.values) };
  }

  async first<T = Record<string, unknown>>(columnName?: string): Promise<T | null> {
    const result = await this.database.execute<T>(this.request());
    const row = result.results?.[0];
    if (row == null) return null;
    if (!columnName) return row;
    if (typeof row !== "object") return null;
    return ((row as Record<string, unknown>)[columnName] ?? null) as T | null;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this.request());
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.execute<T>(this.request());
  }

  async raw<T extends unknown[] = unknown[]>(
    options: { columnNames?: boolean } = {},
  ): Promise<T[]> {
    const result = await this.database.execute<Record<string, unknown>>(this.request());
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
    this.sleep =
      options.sleep ||
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.maxRateLimitRetries = Math.max(0, options.maxRateLimitRetries ?? 4);
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(options.accountId)}/d1/database/${encodeURIComponent(options.databaseId)}/query`;
  }

  prepare(sql: string): D1PreparedStatement {
    return new D1RestPreparedStatement(this, sql) as unknown as D1PreparedStatement;
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    if (!statements.length) return [];
    const requests = statements.map((statement) => {
      if (!(statement instanceof D1RestPreparedStatement)) {
        throw new TypeError("D1 REST batch received a statement from a different database adapter");
      }
      return statement.request();
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
      if (results.some((result) => result.success === false)) {
        throw new Error("Cloudflare D1 API returned an unsuccessful statement result");
      }
      return results;
    }
  }
}

export function createD1RestDatabase(options: D1RestDatabaseOptions): QueryableDatabase {
  return new D1RestDatabase(options);
}
