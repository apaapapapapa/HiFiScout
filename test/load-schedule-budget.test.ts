import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "vite-plus/test";
import { getCrawlerSettings, getShopMaxPages } from "../src/config.js";
import {
  dailyRotationShopForScheduledTime,
  shopForCronAtScheduledTime,
  shopsInDailyRotation,
} from "../src/crawler/schedule.js";
import { isCrawlQuietHours } from "../src/crawler/crawl-window.js";
import { CRAWL_ROTATION_CRON, GENERAL_CRON, isDailyMaintenanceSlot } from "../src/scheduled.js";
import { recordCostSample } from "../scripts/harness/cost.js";
import { LOAD_SAMPLE_BUDGETS } from "../scripts/harness/load-contracts.js";

/** Interpret the current minute/hour Cron grammar; a new grammar must receive explicit coverage. */
function matches(field: string, value: number, max: number): boolean {
  return field.split(",").some((part) => {
    const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    assert.ok(match, `unsupported cron field: ${field}`);
    const [start, end] = match[1] === "*" ? [0, max] : match[1].split("-").map(Number);
    const step = Number(match[2] ?? 1);
    assert.ok(step >= 1 && start >= 0 && (end ?? start) <= max);
    return value >= start && value <= (end ?? start) && (value - start) % step === 0;
  });
}

test("configured day includes all Cron firings, bounded shop passes and page work", async () => {
  const config = JSON.parse(readFileSync("wrangler.jsonc", "utf8")) as {
    triggers: { crons: string[] };
    vars: Env;
  };
  assert.equal(
    new Set(config.triggers.crons).size,
    config.triggers.crons.length,
    "duplicate triggers amplify work",
  );
  for (const day of ["2026-09-22", "2026-12-31", "2027-01-01"]) {
    let scheduledInvocations = 0,
      crawlDispatches = 0,
      plannedPages = 0,
      generalTicks = 0,
      dailySlots = 0;
    const counts = new Map<string, number>();
    for (let minute = 0; minute < 1440; minute++) {
      const at = new Date(Date.parse(`${day}T00:00:00Z`) + minute * 60000);
      for (const cron of config.triggers.crons) {
        const [min, hour, ...calendar] = cron.split(" ");
        assert.deepEqual(
          calendar,
          ["*", "*", "*"],
          "new calendar restrictions require a frequency scenario",
        );
        if (!matches(min, at.getUTCMinutes(), 59) || !matches(hour, at.getUTCHours(), 23)) continue;
        scheduledInvocations++;
        if (cron === GENERAL_CRON) {
          generalTicks++;
          if (isDailyMaintenanceSlot(at)) dailySlots++;
          continue;
        }
        if (isCrawlQuietHours(at.getTime())) continue;
        const shop =
          shopForCronAtScheduledTime(cron, at) ??
          (cron === CRAWL_ROTATION_CRON ? dailyRotationShopForScheduledTime(at) : null);
        if (!shop) {
          assert.equal(cron, CRAWL_ROTATION_CRON, "unaccounted trigger");
          continue;
        }
        // Include disabled shops too: enabling one cannot silently evade the reviewed ceiling.
        crawlDispatches++;
        plannedPages += getShopMaxPages(
          config.vars,
          shop.definition,
          getCrawlerSettings(config.vars).maxPagesPerShop,
        );
        counts.set(shop.key, (counts.get(shop.key) ?? 0) + 1);
      }
    }
    assert.equal(generalTicks, 288);
    assert.equal(dailySlots, 1);
    for (const shop of shopsInDailyRotation()) assert.equal(counts.get(shop.key), 2, shop.key);
    assert.equal(counts.get("audiounion"), 15);
    assert.equal(counts.get("hifido"), 15);
    assert.equal(counts.get("fujiya-avic"), 1);
    const metrics = { scheduledInvocations, crawlDispatches, plannedPages };
    for (const [metric, value] of Object.entries(metrics))
      assert.ok(
        value <= LOAD_SAMPLE_BUDGETS["daily-schedule"].limits[metric as keyof typeof metrics]!,
        JSON.stringify(metrics),
      );
    console.log(
      JSON.stringify({
        event: "daily_load_budget",
        day,
        ...metrics,
        perShop: Object.fromEntries(counts),
      }),
    );
    if (day === "2026-09-22")
      await recordCostSample(
        "daily-schedule",
        "local-mock",
        metrics,
        ["test/load-schedule-budget.test.ts"],
        [
          "Complete configured UTC day including disabled shop slots; initial page ceilings only, not retry/detail HTTP or billed consumption.",
        ],
      );
  }
});
