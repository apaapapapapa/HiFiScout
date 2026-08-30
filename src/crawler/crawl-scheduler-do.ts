import { DurableObject } from "cloudflare:workers";

import { getCrawlFetchSession } from "../db/crawl-fetch-session-repository.js";
import {
  CRAWL_SCHEDULER_COMMAND_VERSION,
  CRAWL_SCHEDULER_OBSERVE_PATH,
  type CrawlSchedulerObserveCommand,
} from "./orchestration.js";

const STORAGE_KEY = "phase1_checkpoint_observation";
const INITIAL_OBSERVATION_DELAY_MS = 10_000;
const RETRY_OBSERVATION_DELAY_MS = 30_000;
const MAX_OBSERVATION_ATTEMPTS = 3;

interface StoredObservation {
  command: CrawlSchedulerObserveCommand;
  attempts: number;
  scheduledAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseCrawlSchedulerObserveCommand(
  value: unknown,
): CrawlSchedulerObserveCommand | null {
  if (!isRecord(value)) return null;
  if (value.schemaVersion !== CRAWL_SCHEDULER_COMMAND_VERSION) return null;
  if (value.type !== "observe_checkpoint") return null;
  for (const field of ["shopKey", "requestedAt", "jobId", "runId"] as const) {
    if (typeof value[field] !== "string" || !value[field]) return null;
  }
  return {
    schemaVersion: CRAWL_SCHEDULER_COMMAND_VERSION,
    type: "observe_checkpoint",
    shopKey: value.shopKey as string,
    requestedAt: value.requestedAt as string,
    jobId: value.jobId as string,
    runId: value.runId as string,
  };
}

/**
 * Phase 1 Durable Object control-plane foundation.
 *
 * The object is intentionally observation-only: Queue remains the authoritative crawl executor in
 * this phase. A selected initial Queue delivery mirrors its immutable dispatch identity here; an
 * Alarm wakes later and reads the existing D1 resumable checkpoint. The DO never writes crawl
 * lifecycle tables and never waits with sleep/setTimeout. Phase 2 can replace this observer with a
 * bounded authoritative step executor without changing the per-shop object identity or binding.
 */
export class CrawlScheduler extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "POST" || url.pathname !== CRAWL_SCHEDULER_OBSERVE_PATH) {
      return new Response("not found", { status: 404 });
    }

    let command: CrawlSchedulerObserveCommand | null = null;
    try {
      command = parseCrawlSchedulerObserveCommand(await request.json());
    } catch {
      // handled as invalid input below
    }
    if (!command) return new Response("invalid command", { status: 400 });

    const existing = await this.ctx.storage.get<StoredObservation>(STORAGE_KEY);
    if (existing) {
      if (existing.command.jobId === command.jobId && existing.command.runId === command.runId) {
        return new Response(null, { status: 202 });
      }
      console.warn(
        JSON.stringify({
          event: "crawl_do_shadow_busy",
          shopKey: command.shopKey,
          requestedAt: command.requestedAt,
          jobId: command.jobId,
          runId: command.runId,
          activeJobId: existing.command.jobId,
          activeRunId: existing.command.runId,
        }),
      );
      return new Response("scheduler busy", { status: 409 });
    }

    const scheduledAt = new Date().toISOString();
    await this.ctx.storage.put<StoredObservation>(STORAGE_KEY, {
      command,
      attempts: 0,
      scheduledAt,
    });
    await this.ctx.storage.setAlarm(Date.now() + INITIAL_OBSERVATION_DELAY_MS);
    console.log(
      JSON.stringify({
        event: "crawl_do_shadow_accepted",
        shopKey: command.shopKey,
        requestedAt: command.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
        scheduledAt,
      }),
    );
    return new Response(null, { status: 202 });
  }

  async alarm(): Promise<void> {
    const observation = await this.ctx.storage.get<StoredObservation>(STORAGE_KEY);
    if (!observation) return;

    const { command } = observation;
    const attempt = observation.attempts + 1;
    const session = await getCrawlFetchSession(this.env.DB, command.runId);
    if (!session && attempt < MAX_OBSERVATION_ATTEMPTS) {
      await this.ctx.storage.put<StoredObservation>(STORAGE_KEY, {
        ...observation,
        attempts: attempt,
      });
      await this.ctx.storage.setAlarm(Date.now() + RETRY_OBSERVATION_DELAY_MS);
      console.log(
        JSON.stringify({
          event: "crawl_do_shadow_checkpoint_pending",
          shopKey: command.shopKey,
          requestedAt: command.requestedAt,
          jobId: command.jobId,
          runId: command.runId,
          attempt,
        }),
      );
      return;
    }

    console.log(
      JSON.stringify({
        event: "crawl_do_shadow_checkpoint_observed",
        shopKey: command.shopKey,
        requestedAt: command.requestedAt,
        jobId: command.jobId,
        runId: command.runId,
        attempt,
        checkpointFound: Boolean(session),
        status: session?.status || null,
        continuationSequence: session?.continuation_sequence ?? null,
        nextPhase: session?.next_phase ?? null,
        nextPageKey: session?.next_page_key ?? null,
        pagesFetched: session?.pages_fetched ?? null,
        pagesParsed: session?.pages_parsed ?? null,
        updatedAt: session?.updated_at || null,
      }),
    );
    await this.ctx.storage.delete(STORAGE_KEY);
  }
}
