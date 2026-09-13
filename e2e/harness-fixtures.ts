import { writeFile } from "node:fs/promises";
import { test as base, expect } from "@playwright/test";
import { readCheckout } from "../scripts/harness/checkpoint.js";

/** Shared by the existing gallery and authenticated admin suites; never imported by production. */
export const test = base.extend<{ harnessEvidence: void }>({
  harnessEvidence: [
    async ({ page, context, baseURL }, use, info) => {
      if (process.env.HARNESS_UI !== "1") {
        await use();
        return;
      }
      if (!baseURL || new URL(baseURL).hostname !== "127.0.0.1")
        throw new Error("UI harness requires its loopback fixture origin");
      const origin = new URL(baseURL).origin;
      const checkout = readCheckout();
      const startedAt = new Date().toISOString();
      const consoleMessages: { type: string; text: string }[] = [];
      const pageErrors: string[] = [];
      const requests: { method: string; url: string; status?: number; error?: string }[] = [];
      const unexpectedOrigins = new Set<string>();
      const cleanUrl = (input: string) => {
        const url = new URL(input);
        return `${url.origin}${url.pathname}`;
      };
      page.on("console", (message) =>
        consoleMessages.push({ type: message.type(), text: message.text().slice(0, 4000) }),
      );
      page.on("pageerror", (error) => pageErrors.push(error.message));
      context.on("request", (request) => {
        const url = new URL(request.url());
        if (["http:", "https:"].includes(url.protocol) && url.origin !== origin)
          unexpectedOrigins.add(url.origin);
        requests.push({ method: request.method(), url: cleanUrl(request.url()) });
      });
      context.on("response", (response) =>
        requests.push({
          method: response.request().method(),
          url: cleanUrl(response.url()),
          status: response.status(),
        }),
      );
      context.on("requestfailed", (request) =>
        requests.push({
          method: request.method(),
          url: cleanUrl(request.url()),
          error: request.failure()?.errorText ?? "unknown",
        }),
      );
      await context.route("**/*", (route) =>
        new URL(route.request().url()).origin === origin
          ? route.continue()
          : route.abort("blockedbyclient"),
      );
      await context.routeWebSocket("**/*", (socket) => {
        const url = new URL(socket.url());
        if (url.protocol === "ws:" && `http://${url.host}` === origin) socket.connectToServer();
        else {
          unexpectedOrigins.add(url.origin);
          socket.close();
        }
      });
      const captureErrors: string[] = [];
      try {
        await use();
      } finally {
        for (const [name, capture] of [
          [
            "page.png",
            () =>
              page.screenshot({ path: info.outputPath("page.png"), fullPage: true, timeout: 5000 }),
          ],
          ["page.html", async () => writeFile(info.outputPath("page.html"), await page.content())],
        ] as const) {
          try {
            await capture();
            await info.attach(name, { path: info.outputPath(name) });
          } catch (error) {
            captureErrors.push(`${name}: ${String(error)}`);
          }
        }
        const current = readCheckout();
        const manifest = {
          schemaVersion: 1,
          sourceSha: checkout.sourceSha,
          checkoutStable:
            !checkout.dirty && !current.dirty && checkout.sourceSha === current.sourceSha,
          testId: info.testId,
          title: info.titlePath,
          retry: info.retry,
          startedAt,
          capturedAt: new Date().toISOString(),
          testStatusAtCapture: info.status,
          url: cleanUrl(page.url()),
          environment: "local-browser-mocks",
          consoleMessages,
          pageErrors,
          requests,
          unexpectedOrigins: [...unexpectedOrigins],
          captureErrors,
        };
        await writeFile(info.outputPath("evidence.json"), `${JSON.stringify(manifest, null, 2)}\n`);
        await info.attach("evidence.json", {
          path: info.outputPath("evidence.json"),
          contentType: "application/json",
        });
        expect(
          [...unexpectedOrigins],
          "unexpected browser origin (blocked by local harness)",
        ).toEqual([]);
        expect(captureErrors, "UI evidence capture").toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };
