import { adminJson, AdminOperationError } from "./admin-shared.js";

function retryDelay(milliseconds: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Only these endpoints can replay safely: preview is read-only; apply has a durable operation ID. */
export async function adminCsvRequest<T>(
  operation: "preview" | "apply",
  init: RequestInit,
  onRetry: () => void,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    init.signal?.throwIfAborted();
    try {
      return await adminJson<T>("/api/admin/csv-import/" + operation, init);
    } catch (error) {
      init.signal?.throwIfAborted();
      const transient =
        error instanceof TypeError ||
        (error instanceof AdminOperationError && [502, 503, 504].includes(error.status));
      if (!transient || attempt >= 2) throw error;
      onRetry();
      await retryDelay(1_000 * (attempt + 1), init.signal);
    }
  }
}
