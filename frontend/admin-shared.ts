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

  constructor(code: string, body: ApiErrorBody | null = null) {
    super(code);
    const id = Number(body?.existingProductId || 0);
    this.existingProductId = Number.isSafeInteger(id) && id > 0 ? id : null;
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
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // HTTP status remains a useful fallback when a proxy returns a non-JSON error.
  }
  if (!response.ok) {
    const parsed = body && typeof body === "object" ? (body as ApiErrorBody) : null;
    const code = typeof parsed?.error === "string" ? parsed.error : `HTTP ${response.status}`;
    throw new AdminOperationError(code, parsed);
  }
  return body as T;
}

export function genericErrorText(error: unknown): string {
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
