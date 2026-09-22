import type { NotificationStatus } from "../src/api/contracts.js";
import { readPreference, savePreference } from "./public-ui-state.js";

const TOKEN_KEY = "hifiscout:notification-token:v1";
function token(create = false): string | null {
  const current = readPreference(TOKEN_KEY);
  if (current && /^[A-Za-z0-9_-]{43}$/.test(current)) return current;
  if (!create) return null;
  const value = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  if (!savePreference(TOKEN_KEY, value))
    throw new Error("通知設定をこの端末に保存できません。ブラウザーの保存設定を確認してください。");
  return value;
}
export function pushAvailable(): boolean {
  return (
    window.isSecureContext &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}
async function request<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  const auth = token();
  const response = await fetch(`/api/notifications/${path}`, {
    method,
    cache: "no-store",
    credentials: "same-origin",
    signal: AbortSignal.timeout(15_000),
    headers: {
      ...(auth ? { Authorization: `Bearer ${auth}` } : {}),
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    if (response.status === 409)
      throw new Error(
        "通知の登録上限に達したか、購読情報を更新できませんでした。不要な通知を解除して再度お試しください。",
      );
    if (response.status === 401)
      throw new Error("通知の登録が期限切れです。通知を有効にし直してください。");
    if (response.status === 400)
      throw new Error("通知条件を登録できません。希望価格と検索条件を確認してください。");
    throw new Error("通知設定を確認できませんでした。通信状態を確認して再度お試しください。");
  }
  return (await response.json()) as T;
}
export async function notificationStatus(): Promise<NotificationStatus> {
  if (!token())
    return { registered: false, watches: [], lastCheck: null, delayed: false, failed: 0 };
  return request<NotificationStatus>("status");
}
export function notificationQuery(query: string, target: string): string {
  const params = new URLSearchParams(query);
  params.delete("sort");
  if (target) {
    if (!/^\d{1,12}$/.test(target)) throw new Error("希望価格は0以上の整数で入力してください。");
    const previous = params.get("maxPrice");
    params.set(
      "maxPrice",
      String(previous ? Math.min(Number(previous), Number(target)) : Number(target)),
    );
  }
  const min = params.get("minPrice"),
    max = params.get("maxPrice");
  if (min && max && Number(min) > Number(max))
    throw new Error("希望価格が検索条件の最低価格を下回っています。");
  return params.toString();
}
export async function enableNotification(input: {
  id: string;
  query: string;
  newListings: boolean;
  priceDrops: boolean;
}): Promise<void> {
  if (!pushAvailable())
    throw new Error(
      "この画面ではプッシュ通知を利用できません。iPhone／iPadはホーム画面に追加してから開いてください。",
    );
  // Permission is requested directly from the user's button action, before any network await.
  const permission = await Notification.requestPermission();
  if (permission !== "granted")
    throw new Error("通知が許可されていません。端末・ブラウザーの通知設定を確認してください。");
  token(true);
  const config = await request<{ publicKey: string }>("config");
  if (!/^[A-Za-z0-9_-]{87}$/.test(config.publicKey))
    throw new Error("通知の設定情報を取得できませんでした。");
  await navigator.serviceWorker.register("/notification-worker.js", { scope: "/" });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const registration = await Promise.race([
    navigator.serviceWorker.ready,
    new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () =>
          reject(new Error("通知の準備が完了しませんでした。画面を開き直して再度お試しください。")),
        15_000,
      );
    }),
  ]).finally(() => clearTimeout(timeout));
  const key = Uint8Array.from(
    atob(config.publicKey.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );
  let subscription = await registration.pushManager.getSubscription();
  if (
    subscription?.options.applicationServerKey &&
    !new Uint8Array(subscription.options.applicationServerKey).every(
      (value, index) => value === key[index],
    )
  ) {
    await subscription.unsubscribe();
    subscription = null;
  }
  subscription ??= await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: key,
  });
  await request("device", "POST", subscription.toJSON());
  await request("watches", "POST", input);
}
export async function disableNotification(id: string): Promise<void> {
  if (token()) await request(`watches/${encodeURIComponent(id)}`, "DELETE");
}
export async function disableAllNotifications(): Promise<void> {
  if (token()) await request("device", "DELETE");
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.getRegistration("/");
    await (await registration?.pushManager.getSubscription())?.unsubscribe();
  }
}
