export const REQUEST_BODY_TOO_LARGE = Symbol("request_body_too_large");

export async function readJsonBody(
  request: Request,
  maxBytes = 64 * 1024,
): Promise<unknown | typeof REQUEST_BODY_TOO_LARGE> {
  if (!request.body) return undefined;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let raw = "";
  let byteLength = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > maxBytes) {
      await reader.cancel("request_body_too_large");
      return REQUEST_BODY_TOO_LARGE;
    }
    raw += decoder.decode(result.value, { stream: true });
  }
  raw += decoder.decode();
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

export function isJsonRequest(request: Request): boolean {
  return (
    request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() ===
    "application/json"
  );
}
