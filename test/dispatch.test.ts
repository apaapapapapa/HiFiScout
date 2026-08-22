import test from "node:test";
import assert from "node:assert/strict";
import { dueDispatchCandidates, isDispatchLeaseActive } from "../src/crawler/dispatch.js";
import { shopSyncStateRow } from "./helpers/fixtures.js";

const ONLY_HIFIDO = {
  AUDIOUNION_ENABLED: "false",
  IPPINKAN_ENABLED: "false",
  FUJIYA_AVIC_ENABLED: "false",
  FORMUSIC_ENABLED: "false",
  U_AUDIO_ENABLED: "false",
  SHIMAMUSEN_ENABLED: "false",
  DYNAMIC_AUDIO_ENABLED: "false",
  AFROAUDIO_ENABLED: "false",
  OSAKAYA_ENABLED: "false",
  SOUNDPIT_ENABLED: "false",
  AVAC_ENABLED: "false",
  HIFIDO_ENABLED: "true",
  HIFIDO_INTERVAL_MINUTES: "30",
  CRAWL_DISPATCH_LEASE_MINUTES: "15",
  CRAWL_RELAY_URL: "https://example.lambda-url.ap-northeast-1.on.aws/",
  CRAWL_RELAY_TOKEN: "test-relay-token",
};

const HIFIDO_AND_AUDIOUNION = {
  ...ONLY_HIFIDO,
  AUDIOUNION_ENABLED: "true",
  AUDIOUNION_INTERVAL_MINUTES: "60",
};

test("recent queue lease prevents duplicate dispatch", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  assert.equal(isDispatchLeaseActive({ queued_at: "2026-08-11T05:50:00.000Z" }, now, 15), true);
  assert.equal(isDispatchLeaseActive({ queued_at: "2026-08-11T05:40:00.000Z" }, now, 15), false);
});

test("due shop is dispatched again after a stale queue lease", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  const recentLease = dueDispatchCandidates(
    ONLY_HIFIDO,
    [
      shopSyncStateRow({
        shop_key: "hifido",
        last_attempt_at: "2026-08-11T05:00:00.000Z",
        queued_at: "2026-08-11T05:50:00.000Z",
      }),
    ],
    now,
  );
  assert.equal(recentLease.length, 0);

  const staleLease = dueDispatchCandidates(
    ONLY_HIFIDO,
    [
      shopSyncStateRow({
        shop_key: "hifido",
        last_attempt_at: "2026-08-11T05:00:00.000Z",
        queued_at: "2026-08-11T05:40:00.000Z",
      }),
    ],
    now,
  );
  assert.deepEqual(
    staleLease.map((candidate) => candidate.adapter.key),
    ["hifido"],
  );
});

test("excluded shop is not selected by the shared scheduler", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  const candidates = dueDispatchCandidates(HIFIDO_AND_AUDIOUNION, [], now, {
    excludeShopKeys: ["audiounion"],
  });

  assert.deepEqual(
    candidates.map((candidate) => candidate.adapter.key),
    ["hifido"],
  );
});
