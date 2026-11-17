/** Shared by all targets and messages in one Queue invocation, below robots/redirect handling. */
export class KnowledgeSourceFetchBudget {
  static readonly limit = 40;
  #used = 0;
  #interrupted = false;

  constructor(private readonly rawFetch: typeof fetch = globalThis.fetch) {}

  get exhausted(): boolean {
    return this.#used >= KnowledgeSourceFetchBudget.limit || this.#interrupted;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    if (this.exhausted) {
      this.#interrupted = true;
      throw new Error("knowledge_catalog_invocation_fetch_budget_exhausted");
    }
    this.#used += 1;
    try {
      // Robots transport already handles redirects one hop at a time. Never allow hidden hops.
      return await this.rawFetch(input, { ...init, redirect: "manual" });
    } catch (error) {
      // A platform rejection also invalidates a result even if a strategy catches the exception.
      if (error instanceof Error && /too many subrequests/i.test(error.message)) {
        this.#interrupted = true;
      }
      throw error;
    }
  };

  assertComplete(): void {
    if (this.#interrupted) throw new Error("knowledge_catalog_invocation_fetch_budget_exhausted");
  }
}
