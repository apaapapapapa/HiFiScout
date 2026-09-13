import { test, expect } from "./fixtures.js";
import { aiCatalogEvaluationCases } from "../../test/fixtures/ai-catalog-evaluation.js";
import type {
  AiAdminCommand,
  AiCatalogDetail,
  AiCatalogPage,
  AiJobSummary,
} from "../../src/api/admin-ai-contracts.js";

const id = "a".repeat(64);
const job: AiJobSummary = {
  id,
  candidateId: 1,
  status: "suggested",
  attempts: 1,
  title: "TAD D-1000 MK2 中古",
  model: "D-1000 MK2",
  manufacturerId: "tad",
  updatedAt: "2026-09-13T00:00:00.000Z",
  error: "",
  reviewOutcome: null,
};
const detail: AiCatalogDetail = {
  job,
  snapshot: aiCatalogEvaluationCases[0].snapshot,
  suggestion: { decision: "suggestion", catalogProductId: 101, evidence: ["D-1000 MK2"] },
  fresh: true,
  handoffUrl: null,
  attempts: [
    {
      ordinal: 1,
      day: "2026-09-13",
      reservedMilli: 18393,
      actualMilli: 5000,
      inputTokens: 500,
      outputTokens: 88,
      latencyMs: 800,
      outcome: "suggested",
    },
  ],
};
const list: AiCatalogPage = {
  enabled: false,
  evaluationApproved: false,
  model: "test-model",
  budget: null,
  items: [job],
  next: null,
};

test("AI review records usefulness separately and exposes a guarded manual handoff", async ({
  page,
  context,
  app,
}) => {
  const commands: AiAdminCommand[] = [];
  let reviewed = false;
  await page.route("**/api/admin/ai-catalog", (route) => {
    const command = route.request().postDataJSON() as AiAdminCommand;
    commands.push(command);
    if (command.action === "list")
      return route.fulfill({ json: { ...list, items: reviewed ? [] : [job] } });
    if (command.action === "review") {
      reviewed = true;
      return route.fulfill({ json: { reviewed: true } });
    }
    if (command.action === "detail")
      return route.fulfill({
        json: reviewed
          ? {
              ...detail,
              job: { ...job, status: "reviewed", reviewOutcome: "useful" },
              handoffUrl: `/?aiCandidateId=1&aiSuggestionId=${id}#candidates`,
            }
          : detail,
      });
    throw new Error(`Unexpected command ${command.action}`);
  });
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#ai");
  await expect(page.getByText("AI判定は停止中", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "根拠を確認" }).click();
  const panel = page.getByRole("region", { name: "AI提案の詳細" });
  await expect(panel.getByText("D-1000 MK2", { exact: true })).toBeVisible();
  await expect(panel.getByRole("link", { name: "未検証候補を開いてVerifyする" })).toHaveCount(0);
  await panel.getByRole("button", { name: "役に立った" }).click();
  await expect(panel.getByRole("link", { name: "未検証候補を開いてVerifyする" })).toHaveAttribute(
    "href",
    new RegExp(`aiSuggestionId=${id}`),
  );
  expect(commands.filter((c) => c.action === "review")).toEqual([
    { action: "review", id, outcome: "useful" },
  ]);
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
  await page.screenshot({ path: "test-results/admin/ai-catalog.png", fullPage: true });
});

test("stale evidence disables review and seller markup renders as text", async ({
  page,
  context,
  app,
}) => {
  await page.route("**/api/admin/ai-catalog", (route) =>
    route.fulfill({
      json:
        route.request().postDataJSON().action === "list"
          ? list
          : {
              ...detail,
              fresh: false,
              snapshot: {
                ...detail.snapshot,
                target: { ...detail.snapshot!.target, title: '<img src=x onerror="alert(1)">' },
              },
            },
    }),
  );
  await context.setExtraHTTPHeaders(await app.headers());
  await page.goto("/#ai");
  await page.getByRole("button", { name: "根拠を確認" }).click();
  const panel = page.getByRole("region", { name: "AI提案の詳細" });
  await expect(panel.getByRole("button", { name: "役に立った" })).toBeDisabled();
  await expect(panel.getByRole("link")).toHaveCount(0);
  await expect(panel.locator("img")).toHaveCount(0);
  await expect(panel).toContainText('<img src=x onerror="alert(1)">');
  expect(app.state.writes).toEqual({ catalog: 0, listing: 0 });
});
