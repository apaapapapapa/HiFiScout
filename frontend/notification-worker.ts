/** This worker handles push only; it does not intercept or cache catalog/API requests. */
interface PushEventLike {
  data: { json(): unknown } | null;
  waitUntil(promise: Promise<unknown>): void;
}
interface ClickEventLike {
  notification: Notification;
  waitUntil(promise: Promise<unknown>): void;
}
interface NotificationWorker {
  registration: ServiceWorkerRegistration;
  clients: { openWindow(path: string): Promise<unknown>; claim(): Promise<void> };
  skipWaiting(): Promise<void>;
  addEventListener(type: "push", listener: (event: PushEventLike) => void): void;
  addEventListener(type: "notificationclick", listener: (event: ClickEventLike) => void): void;
  addEventListener(
    type: "install" | "activate",
    listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void,
  ): void;
}
const scope = globalThis as unknown as NotificationWorker;
scope.addEventListener("install", (event) => event.waitUntil(scope.skipWaiting()));
scope.addEventListener("activate", (event) => event.waitUntil(scope.clients.claim()));
scope.addEventListener("push", (event) => {
  let data: Record<string, unknown> = {};
  try {
    const value: unknown = event.data?.json();
    if (value && typeof value === "object" && !Array.isArray(value))
      data = value as Record<string, unknown>;
  } catch {
    /* Show a safe generic notice for malformed provider payloads. */
  }
  const path =
    typeof data.path === "string" && /^\/p\/[cl]-\d{1,15}$/.test(data.path) ? data.path : "/";
  event.waitUntil(
    scope.registration.showNotification(
      typeof data.title === "string" ? data.title.slice(0, 80) : "HiFiScout",
      {
        body:
          typeof data.body === "string"
            ? data.body.slice(0, 180)
            : "保存した検索の更新を確認してください。",
        tag:
          typeof data.tag === "string" && /^[A-Za-z0-9_-]{43}$/.test(data.tag)
            ? data.tag
            : "hifiscout",
        icon: "/hifiscout-mark.jpg",
        data: { path },
      },
    ),
  );
});
scope.addEventListener("notificationclick", (event) => {
  const data: unknown = event.notification.data;
  const path =
    data &&
    typeof data === "object" &&
    "path" in data &&
    typeof data.path === "string" &&
    /^\/p\/[cl]-\d{1,15}$/.test(data.path)
      ? data.path
      : "/";
  event.notification.close();
  event.waitUntil(scope.clients.openWindow(path));
});
