import { isMetaResponse, isRecord } from "../../frontend/api-client.js";
import { expect, test } from "../fixtures/catalog-test.js";

function metadataDiagnostics(value: unknown): unknown {
  if (!isRecord(value)) return { receivedType: typeof value };
  const baseline = {
    status: value.status,
    shops: [],
    manufacturers: [],
    categories: [],
    categoryFacets: [],
  };
  const rejectedFields = Object.entries(value)
    .filter(([key, field]) => !isMetaResponse({ ...baseline, [key]: field }))
    .map(([key, field]) => ({
      field: key,
      rejectedEntries: Array.isArray(field)
        ? field
            .filter((entry) => !isMetaResponse({ ...baseline, [key]: [entry] }))
            .slice(0, 5)
        : field,
    }));
  return { status: value.status, rejectedFields };
}

test("live metadata satisfies the browser's runtime contract", async ({ request }) => {
  const response = await request.get("/api/meta");
  expect(response.ok(), `/api/meta returned HTTP ${response.status()}`).toBe(true);
  const payload: unknown = await response.json();
  expect(
    isMetaResponse(payload),
    `Metadata rejected by the browser: ${JSON.stringify(metadataDiagnostics(payload))}`,
  ).toBe(true);
});
