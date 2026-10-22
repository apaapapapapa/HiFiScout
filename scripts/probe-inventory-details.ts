/** Read-only deployment evidence. Seller HTML and signed permits never enter the report. */
import { readFile, writeFile } from "node:fs/promises";
import { prepareRelayFetchPermit, fetchPreparedRelayPage } from "../src/crawler/relay.js";
import { prepareDirectFetchPermit, fetchPreparedDirectPage } from "../src/crawler/direct-pacing.js";
import { getShopPlugin } from "../src/crawler/shops/index.js";
import { isRecord } from "../src/types.js";
import type { RelayPage } from "../src/crawler/types.js";

const input: unknown = JSON.parse(await readFile(process.argv[2], "utf8"));
if (!Array.isArray(input)) throw new Error("invalid probe input");
const reports: Record<string, unknown>[] = [];
const relayUrl = process.env.CRAWL_RELAY_URL ?? "";
const relayToken = process.env.CRAWL_RELAY_TOKEN ?? "";
const userAgent = "HiFiScoutBot/0.1";
let failed = false;
// At most six individual pages; each gets its own PREPARE and delay, without retries.
if (input.length > 6) throw new Error("probe budget exceeded");
for (const row of input) {
  if (
    !isRecord(row) ||
    typeof row.shop_key !== "string" ||
    typeof row.source_url !== "string" ||
    typeof row.source_id !== "string" ||
    typeof row.title !== "string" ||
    typeof row.model !== "string"
  )
    throw new Error("invalid probe candidate");
  const plugin = getShopPlugin(row.shop_key);
  const policy = plugin?.capabilities.inventoryRecheck;
  if (!plugin || !policy?.isDetailUrl(row.source_url)) throw new Error("invalid probe URL");
  const report: Record<string, unknown> = {
    id: row.id,
    shop: row.shop_key,
    sourceId: row.source_id,
    sourceUrl: row.source_url,
    activeBefore: row.is_active,
    stockBefore: row.stock_status,
    checkedAt: new Date().toISOString(),
    expected: row.expected ?? null,
  };
  try {
    let page: RelayPage;
    const options = { userAgent, requestDelayMs: 10_000 };
    const prepared =
      plugin.capabilities.transport?.kind === "relay"
        ? await prepareRelayFetchPermit({ relayUrl, relayToken }, row.source_url, options)
        : await prepareDirectFetchPermit(row.source_url, { ...options, baseUrl: plugin.baseUrl });
    const wait = Math.max(0, prepared.notBeforeMs - Date.now() + 100);
    if (wait > 60_000) throw new Error("probe delay exceeds budget");
    await new Promise((resolve) => setTimeout(resolve, wait)); // CI only, outside Lambda/Worker.
    if ("permit" in prepared)
      page = await fetchPreparedRelayPage(
        { relayUrl, relayToken },
        prepared,
        row.source_url,
        options,
      );
    else page = await fetchPreparedDirectPage(prepared, row.source_url, options);
    const classification =
      page.status === 200 &&
      page.contentType.includes("text/html") &&
      !policy.isChallengePage?.(page.body)
        ? policy.classifyPage(page.body, {
            sourceId: row.source_id,
            sourceUrl: row.source_url,
            title: row.title,
            model: row.model,
          })
        : "deferred";
    Object.assign(report, {
      httpStatus: page.status,
      finalUrl: page.finalUrl ?? null,
      classification,
      soldRedirect: Boolean(page.finalUrl?.includes("/sold/")),
    });
    if (row.expected && (classification !== row.expected || !page.finalUrl)) failed = true;
    if (row.expected === "sold_out" && !page.finalUrl?.includes("/sold/")) failed = true;
  } catch {
    // Errors can contain relay URLs or permit details. Persist only this bounded diagnosis.
    Object.assign(report, { classification: "deferred", error: "transport_or_permit_failure" });
    if (row.expected) failed = true;
  }
  reports.push(report);
  console.log(JSON.stringify(report));
}
if (
  !reports.some((r) => r.shop === "hifido" && r.expected === "in_stock") ||
  !reports.some((r) => r.shop === "hifido" && r.expected === "sold_out")
)
  failed = true;
await writeFile(
  process.argv[3],
  JSON.stringify(
    {
      sourceSha: process.env.GITHUB_SHA,
      deployment: "Lambda update Successful (separate workflow step)",
      liveDetailValidation: failed ? "failed" : "passed",
      observedAt: new Date().toISOString(),
      reports,
    },
    null,
    2,
  ) + "\n",
);
if (failed) process.exitCode = 1;
