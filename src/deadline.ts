/**
 * A wall-clock budget for one Worker invocation, and the guard that keeps a call from outliving it.
 *
 * Cloudflare terminates an invocation that exceeds the platform's wall-clock limit without running
 * any catch or finally block. Work that blocks past that limit therefore leaves no terminal record
 * of its own: the row it opened stays `running` until a later sweep closes it by inference, and the
 * reason it stopped is lost. In production this is not a corner case — it is how nearly every crawl
 * failure is currently reported.
 *
 * Every outbound HTTP call the crawler makes already carries its own timeout. What can still block
 * forever is a platform binding — D1, R2, Queue, Browser — because none of them accepts an
 * `AbortSignal` or applies a timeout of its own.
 *
 * A guard cannot cancel such a call; nothing in the Workers runtime can. What it does is stop
 * *waiting* for one, which is the half that matters: control returns to the caller's catch block
 * while the invocation is still alive, so the failure is recorded, attributed to a stage, and
 * diagnosable. Because the call itself is not cancelled, a guarded write may still land after the
 * rejection — so only an idempotent write may be guarded. Every write on the crawl path is an
 * upsert or a status-guarded update, which is what makes this safe here.
 */

export class DeadlineExceededError extends Error {
  /** What was being awaited, so the failure names a stage rather than a stack a kill never left. */
  readonly label: string;
  /** How long this call had waited when the budget ran out. */
  readonly waitedMs: number;
  /** The budget the wait was measured against. */
  readonly budgetMs: number;

  constructor({
    label,
    waitedMs,
    budgetMs,
  }: {
    label: string;
    waitedMs: number;
    budgetMs: number;
  }) {
    super(`${label} exceeded its ${budgetMs}ms budget after ${waitedMs}ms`);
    this.name = "DeadlineExceededError";
    this.label = label;
    this.waitedMs = waitedMs;
    this.budgetMs = budgetMs;
  }
}

export function isDeadlineExceeded(error: unknown): error is DeadlineExceededError {
  return error instanceof DeadlineExceededError;
}

export interface InvocationDeadline {
  readonly budgetMs: number;
  readonly startedAtMs: number;
  elapsedMs(): number;
  /** Budget left, floored at zero. */
  remainingMs(): number;
  expired(): boolean;
  /**
   * Throws when the budget is already spent, so a loop can stop before starting the next unit.
   *
   * This is the cheap half of the contract: it costs nothing per iteration and it fails at a point
   * where the caller still knows exactly how far it got.
   */
  check(label: string): void;
  /**
   * Awaits one operation, or rejects with {@link DeadlineExceededError} when the budget runs out.
   *
   * The operation keeps running — see the module comment — so the caller must be able to tolerate
   * its write landing late.
   */
  guard<T>(label: string, operation: () => Promise<T>): Promise<T>;
}

/**
 * Starts a budget now, or from an earlier moment the caller already recorded.
 *
 * Passing `startedAtMs` is how fetch, parse and the derived stages are all measured against the
 * same clock: what the platform kills is the whole invocation, not any one stage within it.
 */
export function createInvocationDeadline(
  budgetMs: number,
  startedAtMs: number = Date.now(),
): InvocationDeadline {
  const elapsedMs = (): number => Date.now() - startedAtMs;
  const remainingMs = (): number => Math.max(0, budgetMs - elapsedMs());

  const exceeded = (label: string): DeadlineExceededError =>
    new DeadlineExceededError({ label, waitedMs: elapsedMs(), budgetMs });

  return {
    budgetMs,
    startedAtMs,
    elapsedMs,
    remainingMs,
    expired: () => remainingMs() <= 0,

    check(label: string): void {
      if (remainingMs() <= 0) throw exceeded(label);
    },

    async guard<T>(label: string, operation: () => Promise<T>): Promise<T> {
      const remaining = remainingMs();
      if (remaining <= 0) throw exceeded(label);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const expiry = new Promise<never>((_resolve, reject) => {
        const arm = (): void => {
          const waitMs = remainingMs();
          if (waitMs <= 0) {
            reject(exceeded(label));
            return;
          }
          // setTimeout may fire just before Date.now() reaches the requested wall-clock boundary
          // because the scheduler and wall clock have different resolution. Re-check the actual
          // deadline when it fires and, if necessary, wait only the small remainder. This keeps the
          // invariant that a DeadlineExceededError is emitted only after expired() becomes true.
          timer = setTimeout(arm, waitMs);
        };
        arm();
      });
      try {
        // The operation is invoked inside the race so a synchronous throw arrives as a rejection
        // rather than escaping before the timer is armed.
        return await Promise.race([(async () => operation())(), expiry]);
      } finally {
        // Without this an armed timer keeps the invocation alive after the work is done.
        clearTimeout(timer);
      }
    },
  };
}
