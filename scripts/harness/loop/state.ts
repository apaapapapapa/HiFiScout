import { readFile } from "node:fs/promises";
import { isRecord } from "../../../src/types.js";
import { requireTimestamp } from "../report.js";
import { updateJsonRevision } from "../store.js";
import { digest, integer, loopSpecDigest, parseLoopSpec } from "./contract.js";
import type { LoopSpec } from "./contract.js";

export const eventTypes = [
  "created",
  "attempt-started",
  "attempt-finished",
  "review-requested",
  "reviewed",
  "delivery-observed",
  "blocked",
  "resumed",
  "stopped",
  "heartbeat",
] as const;
export type LoopEventType = (typeof eventTypes)[number];
export interface LoopEvent {
  sequence: number;
  at: string;
  type: LoopEventType;
  data: Record<string, unknown>;
  previousDigest: string;
  digest: string;
}
export interface LoopRun {
  schemaVersion: 1;
  revision: number;
  spec: LoopSpec;
  specDigest: string;
  startedAt: string;
  updatedAt: string;
  events: LoopEvent[];
}

function assertJsonData(value: unknown, seen = new Set<object>()): void {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === null || seen.has(value))
    throw new Error("non_json_loop_event_data");
  seen.add(value);
  if (Array.isArray(value)) {
    if (
      Object.getPrototypeOf(value) !== Array.prototype ||
      Reflect.ownKeys(value).length !== value.length + 1
    )
      throw new Error("non_json_loop_event_data");
    for (let i = 0; i < value.length; i++) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
      if (!descriptor || !Object.hasOwn(descriptor, "value"))
        throw new Error("non_json_loop_event_data");
      assertJsonData(descriptor.value, seen);
    }
  } else {
    if (Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error("non_json_loop_event_data");
    for (const key of Reflect.ownKeys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
      if (typeof key !== "string" || !descriptor.enumerable || !Object.hasOwn(descriptor, "value"))
        throw new Error("non_json_loop_event_data");
      assertJsonData(descriptor.value, seen);
    }
  }
  seen.delete(value);
}

function makeEvent(
  sequence: number,
  at: string,
  type: LoopEventType,
  data: Record<string, unknown>,
  previousDigest: string,
): LoopEvent {
  assertJsonData(data);
  const payload: Record<string, unknown> = JSON.parse(JSON.stringify(data));
  const fields = { sequence, at: requireTimestamp(at), type, data: payload, previousDigest };
  return { ...fields, digest: digest(fields) };
}

export function parseLoopRun(value: unknown): LoopRun {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.events) ||
    !value.events.length ||
    value.events.length > 1000
  )
    throw new Error("invalid_loop_run");
  const spec = parseLoopSpec(value.spec);
  const specDigest = loopSpecDigest(spec);
  if (value.specDigest !== specDigest) throw new Error("loop_contract_changed");
  const startedAt = requireTimestamp(value.startedAt);
  let previousDigest = specDigest;
  let previousAt = startedAt;
  const events = value.events.map((item, index): LoopEvent => {
    if (
      !isRecord(item) ||
      !isRecord(item.data) ||
      !eventTypes.some((type) => type === item.type) ||
      item.sequence !== index + 1 ||
      item.previousDigest !== previousDigest ||
      (index === 0 ? item.type !== "created" : item.type === "created")
    )
      throw new Error("invalid_loop_event");
    const event = makeEvent(
      index + 1,
      requireTimestamp(item.at),
      item.type as LoopEventType,
      item.data,
      previousDigest,
    );
    if (
      event.digest !== item.digest ||
      event.at < previousAt ||
      JSON.stringify(event.data).length > 262_144
    )
      throw new Error("loop_history_changed");
    previousAt = event.at;
    previousDigest = event.digest;
    return event;
  });
  const revision = integer(value.revision, "loop_revision", 1);
  const updatedAt = requireTimestamp(value.updatedAt);
  if (revision !== events.length || updatedAt !== previousAt || events[0].at !== startedAt)
    throw new Error("invalid_loop_revision_or_interval");
  const run: LoopRun = {
    schemaVersion: 1,
    revision,
    spec,
    specDigest,
    startedAt,
    updatedAt,
    events,
  };
  if (JSON.stringify(run, null, 2).length + 1 > 4_194_304) throw new Error("loop_state_too_large");
  return run;
}

export async function readLoopRun(path: string): Promise<LoopRun> {
  const raw = await readFile(path, "utf8");
  if (raw.length > 4_194_304) throw new Error("loop_state_too_large");
  return parseLoopRun(JSON.parse(raw));
}

export async function createLoopRun(
  value: unknown,
  path: string,
  at = new Date().toISOString(),
): Promise<LoopRun> {
  const spec = parseLoopSpec(value);
  const specDigest = loopSpecDigest(spec);
  const startedAt = requireTimestamp(at);
  return updateJsonRevision(path, 0, parseLoopRun, () => ({
    schemaVersion: 1,
    revision: 1,
    spec,
    specDigest,
    startedAt,
    updatedAt: startedAt,
    events: [makeEvent(1, startedAt, "created", {}, specDigest)],
  }));
}

export async function appendLoopEvent(
  path: string,
  expectedRevision: number,
  specDigest: string,
  type: Exclude<LoopEventType, "created">,
  data: Record<string, unknown>,
  at = new Date().toISOString(),
): Promise<LoopRun> {
  return updateJsonRevision(path, expectedRevision, parseLoopRun, (previous) => {
    if (!previous) throw new Error("loop_run_missing");
    if (previous.specDigest !== specDigest) throw new Error("loop_contract_changed");
    const event = makeEvent(previous.revision + 1, at, type, data, previous.events.at(-1)!.digest);
    return {
      ...previous,
      revision: event.sequence,
      updatedAt: event.at,
      events: [...previous.events, event],
    };
  });
}
