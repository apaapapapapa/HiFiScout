import { afterAll, beforeAll, expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

let mf: Miniflare;
beforeAll(async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      minify: false,
      target: "es2022",
      lib: { entry: "test/knowledge-catalog-fetch-worker.ts", formats: ["es"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("bundle");
  const chunk = output.output.find((row) => row.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("chunk");
  mf = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: "catalog-budget",
          modules: true,
          script: chunk.code,
          compatibilityDate: "2026-08-11",
          compatibilityFlags: ["nodejs_compat"],
          outboundService: "fixture-origin",
        },
        {
          name: "fixture-origin",
          modules: true,
          compatibilityDate: "2026-08-11",
          script: `export default {
            fetch(request) {
              if (new URL(request.url).pathname === "/redirect") {
                return new Response("redirect body", {
                  status: 302,
                  headers: { location: "https://source.invalid/product" },
                });
              }
              return new Response("official product");
            },
          };`,
        },
      ],
    }),
  );
}, 30_000);
afterAll(async () => mf?.dispose());

it("calls the native Workers fetch with its receiver and keeps redirects manual", async () => {
  const response = await mf.dispatchFetch("https://fixture.invalid/redirect");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toEqual({
    status: 302,
    body: "redirect body",
    location: "https://source.invalid/product",
  });
});

it("permits forty native requests and rejects the next without accepting a partial result", async () => {
  const response = await mf.dispatchFetch("https://fixture.invalid/budget");
  const body = await response.text();
  expect(response.status, body).toBe(200);
  expect(JSON.parse(body)).toEqual({
    completed: 40,
    rejected: "knowledge_catalog_invocation_fetch_budget_exhausted",
    interrupted: true,
    exhausted: true,
  });
});
