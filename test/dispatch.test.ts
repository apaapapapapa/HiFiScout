import { test } from "vite-plus/test";
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
  SOUND_SUPPORT_ENABLED: "false",
  AVAC_ENABLED: "false",
  TEREON_ENABLED: "false",
  AUDIO_SPACE_CORE_ENABLED: "false",
  HOME_SHOKAI_ENABLED: "false",
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

test("a queued child job stays reserved regardless of queue wait", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  assert.equal(isDispatchLeaseActive({ queued_at: "2026-08-11T05:50:00.000Z" }, now, 15), true);
  assert.equal(isDispatchLeaseActive({ queued_at: "2026-08-11T05:40:00.000Z" }, now, 15), true);
});

test("a due shop is not moved to the queue tail while its child job is still reserved", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  for (const queuedAt of ["2026-08-11T05:50:00.000Z", "2026-08-11T05:00:00.000Z"]) {
    const candidates = dueDispatchCandidates(
      ONLY_HIFIDO,
      [
        shopSyncStateRow({
          shop_key: "hifido",
          last_attempt_at: "2026-08-11T05:00:00.000Z",
          queued_at: queuedAt,
        }),
      ],
      now,
    );
    assert.equal(candidates.length, 0, queuedAt);
  }
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
