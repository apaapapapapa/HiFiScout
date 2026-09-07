import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { expect, test as base } from "@playwright/test";
import adminWorker from "../../src/admin/entry.js";
import { createMockAccess } from "./mock-access.js";
import { createMockAdminRpc } from "./mock-rpc.js";

const assets = new Map([
  ["/index.html", "text/html; charset=utf-8"],
  ["/admin-console.js", "text/javascript; charset=utf-8"],
  ["/admin-console.css", "text/css; charset=utf-8"],
  ["/catalog-admin.css", "text/css; charset=utf-8"],
  ["/listing-admin.css", "text/css; charset=utf-8"],
  ["/hifiscout-mark.jpg", "image/jpeg"],
]);

async function startAdminApp() {
  const access = await createMockAccess();
  const { rpc, state } = createMockAdminRpc();
  const serverErrors: string[] = [];
  const env: Parameters<typeof adminWorker.fetch>[1] = {
    ACCESS_TEAM_DOMAIN: access.teamDomain,
    ACCESS_AUD: access.audience,
    CATALOG_ADMIN: rpc,
    // Only Fetcher's HTTP method is needed; no Worker bindings or Cloudflare credentials exist here.
    ADMIN_ASSETS: {
      async fetch(request: Request) {
        const pathname = new URL(request.url).pathname;
        const contentType = assets.get(pathname);
        if (!contentType) return new Response("Not found", { status: 404 });
        const file = new URL(`../../admin-public${pathname}`, import.meta.url);
        return new Response(new Uint8Array(await readFile(file)), {
          headers: { "content-type": contentType },
        });
      },
    } as Fetcher,
  };
  let origin = "";
  const server = createServer((incoming, outgoing) => {
    void (async () => {
      // Bind and accept only this ephemeral loopback origin, including against DNS rebinding.
      if (incoming.headers.host !== new URL(origin).host) {
        outgoing.writeHead(403).end();
        return;
      }
      const headers = new Headers();
      for (const [name, value] of Object.entries(incoming.headers)) {
        if (Array.isArray(value)) value.forEach((item) => headers.append(name, item));
        else if (value !== undefined) headers.set(name, value);
      }
      const chunks: Buffer[] = [];
      for await (const chunk of incoming) chunks.push(Buffer.from(chunk));
      const method = incoming.method || "GET";
      const request = new Request(new URL(incoming.url || "/", origin), {
        method,
        headers,
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      // Use the production entry, including its Access, JSON, CSRF and security-header guards.
      const response = await adminWorker.fetch(request, env);
      outgoing.writeHead(response.status, Object.fromEntries(response.headers));
      outgoing.end(Buffer.from(await response.arrayBuffer()));
    })().catch((error: unknown) => {
      serverErrors.push(String(error));
      if (!outgoing.headersSent) outgoing.writeHead(500);
      outgoing.end("Local admin test server failed");
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing local admin address");
  origin = `http://127.0.0.1:${address.port}`;
  // This isolated Playwright worker owns the mock until teardown. No outbound network fallback.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = access.fetchJwks;
  return {
    url: origin,
    headers: access.headers,
    state,
    async close() {
      try {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
          server.closeAllConnections();
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
      expect(serverErrors, "local Worker errors").toEqual([]);
      expect(access.unexpectedRequests, "unexpected outbound fetches").toEqual([]);
      expect(state.unexpectedCalls, "unmocked RPC calls").toEqual([]);
    },
  };
}

export const test = base.extend<{ app: Awaited<ReturnType<typeof startAdminApp>> }>({
  // eslint-disable-next-line no-empty-pattern -- Playwright requires a destructured fixture argument.
  app: async ({}, use) => {
    const app = await startAdminApp();
    try {
      await use(app);
    } finally {
      await app.close();
    }
  },
  baseURL: async ({ app }, use) => {
    await use(app.url);
  },
});

export { expect };
