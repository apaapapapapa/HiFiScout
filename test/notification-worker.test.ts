import { expect, it } from "vite-plus/test";
import { build } from "vite-plus";
import { runInNewContext } from "node:vm";

it("the built push worker displays received notices and opens only a local product path", async () => {
  const bundle = await build({
    configFile: false,
    publicDir: false,
    logLevel: "silent",
    build: {
      write: false,
      target: "es2022",
      lib: { entry: "frontend/notification-worker.ts", name: "Notifications", formats: ["iife"] },
    },
  });
  const output = Array.isArray(bundle) ? bundle[0] : bundle;
  if (!("output" in output)) throw new Error("missing_bundle");
  const chunk = output.output.find((value) => value.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("missing_chunk");
  const handlers = new Map<string, (event: unknown) => void>();
  const notices: { title: string; data: { path: string }; tag: string }[] = [];
  const paths: string[] = [];
  runInNewContext(chunk.code, {
    addEventListener: (name: string, handler: (event: unknown) => void) =>
      handlers.set(name, handler),
    registration: {
      showNotification: async (title: string, options: { data: { path: string }; tag: string }) => {
        notices.push({ title, ...options });
      },
    },
    clients: {
      openWindow: async (path: string) => {
        paths.push(path);
      },
    },
  });
  const tasks: Promise<unknown>[] = [];
  const waitUntil = (task: Promise<unknown>) => tasks.push(task);
  handlers.get("push")!({
    data: { json: () => ({ title: "HiFiScout · 新着", path: "/p/c-123", tag: "A".repeat(43) }) },
    waitUntil,
  });
  await Promise.all(tasks);
  expect(notices[0]).toEqual(
    expect.objectContaining({
      title: "HiFiScout · 新着",
      data: { path: "/p/c-123" },
      tag: "A".repeat(43),
    }),
  );
  let closed = false;
  handlers.get("notificationclick")!({
    notification: {
      data: notices[0].data,
      close: () => {
        closed = true;
      },
    },
    waitUntil,
  });
  handlers.get("notificationclick")!({
    notification: { data: { path: "https://evil.test/" }, close: () => {} },
    waitUntil,
  });
  await Promise.all(tasks);
  expect(paths).toEqual(["/p/c-123", "/"]);
  expect(closed).toBe(true);
  expect(handlers.has("fetch")).toBe(false);
});
