/**
 * Test doubles for the Knowledge Catalog verification queue.
 *
 * The queue's decisions turn on whether a conditional write applied — a claim, a domain lease, a
 * retry — so the D1 double lets a test choose `meta.changes` per statement and records what ran.
 * It is deliberately not a SQLite emulator: assertions are about which statements the handler
 * decided to issue, not about what a real database would return.
 */

import { asQueryableDatabase } from "./d1.js";
import type { KnowledgeCatalogQueueMessage } from "../../src/crawler/types.js";
import type { KnowledgeCatalogQueueEnv } from "../../src/knowledge-catalog-verification-queue.js";

export interface QueueStatement {
  sql: string;
  binds: unknown[];
}

export interface QueueStatementResponse {
  /** `meta.changes`. Conditional SQL reports 0 when it did not apply. Defaults to 1. */
  changes?: number;
  /** `meta.last_row_id`, for inserts whose id the caller reads back. Defaults to 1. */
  lastRowId?: number;
  row?: unknown;
  rows?: unknown[];
}

export interface QueueDatabaseRecorder {
  /** Every statement executed, in order. */
  readonly statements: QueueStatement[];
  /** Statements whose SQL contains `fragment`. */
  ran(fragment: string): QueueStatement[];
}

export function queueDatabase(respond: (sql: string) => QueueStatementResponse = () => ({})) {
  const statements: QueueStatement[] = [];
  const recorder: QueueDatabaseRecorder = {
    statements,
    ran(fragment: string) {
      return statements.filter((statement) => statement.sql.includes(fragment));
    },
  };
  const database = asQueryableDatabase({
    ...recorder,
    prepare(sql: string) {
      // Recorded on the terminal call, so a statement counts once whether or not it binds first.
      const execute = (binds: unknown[]) => {
        statements.push({ sql, binds });
        const response = respond(sql);
        return {
          async all() {
            return { results: response.rows || [] };
          },
          async first() {
            return response.row ?? null;
          },
          async run() {
            return {
              success: true,
              meta: { changes: response.changes ?? 1, last_row_id: response.lastRowId ?? 1 },
            };
          },
        };
      };
      return {
        bind: (...binds: unknown[]) => execute(binds),
        all: () => execute([]).all(),
        first: () => execute([]).first(),
        run: () => execute([]).run(),
      };
    },
    async batch(list: unknown[]) {
      return list.map(() => ({ success: true, meta: { changes: 1 } }));
    },
  });
  return database as typeof database & QueueDatabaseRecorder;
}

export function knowledgeJobRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 7,
    run_id: 3,
    job_key: "knowledge-catalog:3:candidate:11",
    job_type: "candidate",
    target_id: 11,
    manufacturer_id: "luxman",
    hostname: "www.luxman.co.jp",
    status: "processing",
    outcome: "",
    delivery_attempts: 1,
    source_attempts: 0,
    promoted: 0,
    rechecked: 0,
    enqueued_at: "2026-01-01T00:00:00.000Z",
    available_at: null,
    claimed_at: "2026-01-01T00:00:00.000Z",
    lease_expires_at: null,
    finished_at: null,
    last_message: "",
    ...overrides,
  };
}

export interface RecordedQueueMessage {
  /** One entry per `ack()`. */
  readonly acks: number[];
  /** One entry per `retry()`, with the options it was given. */
  readonly retries: Array<{ delaySeconds?: number }>;
  readonly message: Message<KnowledgeCatalogQueueMessage>;
}

export function queueMessage(
  body: Partial<KnowledgeCatalogQueueMessage> = {},
): RecordedQueueMessage {
  const acks: number[] = [];
  const retries: Array<{ delaySeconds?: number }> = [];
  return {
    acks,
    retries,
    message: {
      body: {
        jobId: 7,
        runId: 3,
        jobType: "candidate",
        mode: "daily_candidates",
        preferRetries: false,
        verifierVersion: 0,
        hostname: "www.luxman.co.jp",
        ...body,
      } as KnowledgeCatalogQueueMessage,
      ack() {
        acks.push(1);
      },
      retry(options: { delaySeconds?: number } = {}) {
        retries.push(options);
      },
    } as unknown as Message<KnowledgeCatalogQueueMessage>,
  };
}

export interface SentQueueMessage {
  body: KnowledgeCatalogQueueMessage;
  options?: { delaySeconds?: number };
}

type KnowledgeQueueBinding = KnowledgeCatalogQueueEnv["KNOWLEDGE_CATALOG_QUEUE"];

/** Records what dispatch enqueued, so a test can assert the finalizer's delay and the batch size. */
export function queueBinding() {
  const sent: SentQueueMessage[] = [];
  const binding = {
    async send(body: KnowledgeCatalogQueueMessage, options?: QueueSendOptions) {
      sent.push({ body, ...(options ? { options } : {}) });
    },
    async sendBatch(messages: Iterable<MessageSendRequest<KnowledgeCatalogQueueMessage>>) {
      for (const message of messages) sent.push({ body: message.body });
    },
  };
  // Cloudflare's send methods resolve to backlog metadata that dispatch awaits and ignores. The
  // cast is confined here rather than inventing figures no assertion would read.
  return { sent, binding: binding as unknown as KnowledgeQueueBinding };
}

export function queueEnv(
  db: ReturnType<typeof queueDatabase>,
  binding = queueBinding().binding,
  overrides: Partial<KnowledgeCatalogQueueEnv> = {},
): KnowledgeCatalogQueueEnv {
  return { DB: db, KNOWLEDGE_CATALOG_QUEUE: binding, ...overrides };
}
