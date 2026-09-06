export interface CategoryFacet {
  id: string;
  name: string;
  classifiable: boolean;
  filterable: boolean;
}

export type MessageKind = "info" | "error" | "success";

export interface StatusMessage {
  text: string;
  kind: MessageKind;
}

export const EMPTY_STATUS: StatusMessage = { text: "", kind: "info" };

interface ApiErrorBody {
  error?: unknown;
  existingProductId?: unknown;
}

export class AdminOperationError extends Error {
  readonly existingProductId: number | null;
  readonly status: number;

  constructor(code: string, body: ApiErrorBody | null = null, status = 0) {
    super(code);
    this.status = status;
    const id = Number(body?.existingProductId || 0);
    this.existingProductId = Number.isSafeInteger(id) && id > 0 ? id : null;
  }

  get requiresAuthentication(): boolean {
    return this.message === "cloudflare_access_required";
  }
}

export async function adminJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set("content-type", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "manual",
  });
  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    throw new AdminOperationError("cloudflare_access_required", null, 403);
  }
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    if (response.ok) {
      throw new AdminOperationError("admin_invalid_response", null, response.status);
    }
  }
  if (!response.ok) {
    const parsed = body && typeof body === "object" ? (body as ApiErrorBody) : null;
    const code =
      typeof parsed?.error === "string"
        ? parsed.error
        : response.status === 401 || response.status === 403
          ? "cloudflare_access_required"
          : `HTTP ${response.status}`;
    throw new AdminOperationError(code, parsed, response.status);
  }
  return body as T;
}

export function genericErrorText(error: unknown): string {
  if (error instanceof AdminOperationError) {
    if (error.requiresAuthentication)
      return "ログインの有効期限が切れたか、認証を確認できませんでした。別タブでログインを確認してから再開してください。";
    if (error.message === "cloudflare_access_unavailable")
      return "認証サービスに一時的に接続できません。少し待ってから再開してください。";
    if (error.message === "admin_invalid_response")
      return "サーバーから正しい応答を受け取れませんでした。ログイン状態を確認してください。";
  }
  return error instanceof Error ? error.message : String(error);
}

export function dateText(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString("ja-JP");
}

export function safeSourceUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
