import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import {
  dueDispatchCandidates,
  isDispatchReservationActive,
} from "../src/crawler/dispatch.js";
import { crawlDispatchToken } from "../src/db/shop-state-repository.js";
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

test("an active Durable Object dispatch remains reserved regardless of elapsed time", () => {
  const requestedAt = "2026-08-11T05:50:00.000Z";
  assert.equal(
    isDispatchReservationActive({
      ...shopSyncStateRow({ shop_key: "hifido" }),
      dispatch_requested_at: requestedAt,
      dispatch_token: crawlDispatchToken("hifido", requestedAt),
    } as never),
    true,
  );
});

test("a due shop is not selected while its Durable Object dispatch is still reserved", () => {
  const now = new Date("2026-08-11T06:00:00.000Z");
  for (const requestedAt of ["2026-08-11T05:50:00.000Z", "2026-08-11T05:00:00.000Z"]) {
    const candidates = dueDispatchCandidates(
      ONLY_HIFIDO,
      [
        {
          ...shopSyncStateRow({
            shop_key: "hifido",
            last_attempt_at: "2026-08-11T05:00:00.000Z",
          }),
          dispatch_requested_at: requestedAt,
          dispatch_token: crawlDispatchToken("hifido", requestedAt),
          dispatch_last_sent_at: requestedAt,
        } as never,
      ],
      now,
    );
    assert.equal(candidates.length, 0, requestedAt);
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
