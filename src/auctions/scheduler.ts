import type { YahooAuctionSource } from "./types.js";
import { AuctionStore } from "./storage.js";
import {
  AUCTION_MAX_ATTEMPTS,
  AUCTION_PAGE_LIMIT,
  auctionFetchDue,
  auctionRetryAt,
  emptyAuctionCharge,
  reserveAuctionBudget,
  type AuctionRuntimeState,
  type AuctionTask,
} from "./runtime-policy.js";
import { auctionRobotsPermit, auctionTaskUrl, type AuctionTransport } from "./yahoo/acquisition.js";
import {
  yahooAuctionFetchPolicy,
  YAHOO_AUCTION_ORIGIN,
  yahooAuctionCategory,
} from "./yahoo/policy.js";

/** Durable state owns all admission; a process-local lock is never the recovery mechanism. */
export class AuctionScheduler {
  constructor(
    readonly store: AuctionStore,
    readonly transport: AuctionTransport,
    readonly source: YahooAuctionSource,
    readonly allowed: () => boolean,
    readonly clock = Date.now,
    readonly maintenance?: {
      nextDue(now: number): number | null;
      run(now: number, beforeRead?: () => Promise<void>): Promise<void>;
    },
  ) {}

  async control(
    action:
      | "pause"
      | "resume"
      | "wake"
      | "public_pause"
      | "public_resume"
      | "retry_failed"
      | "clear_halt",
    categories?: string[],
  ): Promise<void> {
    const now = this.clock();
    this.store.storage.transactionSync(() => {
      const state = this.store.runtime(now);
      if (action === "clear_halt") {
        if (!state.paused || !this.allowed()) throw new Error("auction_halt_review_required");
        if (state.halt === "robots_disallowed") state.robots = null;
        state.halt = null;
        state.throttleCount = 0;
        state.generation++;
      }
      if (action === "pause") {
        state.paused = true;
        state.generation++;
      }
      if (action === "resume") {
        state.paused = false;
        state.generation++;
      }
      if (action === "public_pause") state.publicPaused = true;
      if (action === "public_resume") state.publicPaused = false;
      if (action === "retry_failed") {
        state.generation++;
        for (const row of this.store.sql<{ value: string }>(
          "task",
          "SELECT value FROM auction_tasks WHERE due=? ORDER BY id LIMIT 20",
          Number.MAX_SAFE_INTEGER,
        )) {
          const failed = JSON.parse(row.value) as AuctionTask;
          this.store.task({ ...failed, attempts: 0, sequence: null, endChecks: 0, due: now });
        }
      }
      if (categories) {
        if (categories.length > 2 || categories.some((id) => !yahooAuctionCategory(id)))
          throw new Error("invalid_auction_categories");
        const next = [...new Set(categories)];
        if (
          next.length !== state.categories.length ||
          next.some((id) => !state.categories.includes(id))
        )
          state.generation++;
        state.categories = next;
      }
      // Resume never clears a source halt, exhausted UTC budget, pacing or backoff.
      if (!state.paused && this.allowed())
        for (const categoryId of state.categories) {
          const id = `discover:${categoryId}`;
          if (!this.store.getTask(id))
            this.store.task({
              id,
              kind: "discover",
              categoryId,
              auctionId: null,
              page: 1,
              due: now,
              attempts: 0,
              sequence: null,
            });
        }
      this.store.saveRuntime(state);
    });
    await this.rearm();
  }

  async rearm(): Promise<void> {
    const now = this.clock();
    const state = this.store.runtime(now);
    if (!this.allowed() || state.paused || state.halt) {
      await this.store.deleteAlarm();
      return;
    }
    const next = this.store.nextTask(state.lastKind, now);
    const maintenanceAt = this.maintenance?.nextDue(now) ?? Number.MAX_SAFE_INTEGER;
    if (
      (!next || next.due === Number.MAX_SAFE_INTEGER) &&
      maintenanceAt === Number.MAX_SAFE_INTEGER
    ) {
      await this.store.deleteAlarm();
      return;
    }
    const target = Math.max(
      now + 1,
      Math.min(
        next ? auctionFetchDue(state, next.due, now + 1) : Number.MAX_SAFE_INTEGER,
        maintenanceAt,
      ),
    );
    if ((await this.store.getAlarm()) !== target) await this.store.setAlarm(target);
  }

  /** Admission refusal still preserves a single durable UTC wake; it never refunds charges. */
  async deferForBudget(): Promise<void> {
    const now = this.clock();
    const state = this.store.runtime(now);
    if (!this.allowed() || state.paused || state.halt) return;
    const reset = (Math.max(state.utcDay, Math.floor(now / 86_400_000)) + 1) * 86_400_000;
    const target = auctionFetchDue(state, reset, now);
    if ((await this.store.getAlarm()) !== target) await this.store.setAlarm(target);
  }

  async alarm(): Promise<void> {
    const now = this.clock();
    let state = this.store.runtime(now);
    if (!this.allowed() || state.paused || state.halt) return;
    const maintenanceAt = this.maintenance?.nextDue(now);
    if (maintenanceAt != null && maintenanceAt <= now) {
      await this.maintenance!.run(now, () => this.rearm());
      await this.rearm();
      return;
    }
    const task = this.store.nextTask(state.lastKind, now);
    if (!task) return;
    if (!state.categories.includes(task.categoryId)) {
      this.store.sql("task", "DELETE FROM auction_tasks WHERE id=?", task.id);
      await this.rearm();
      return;
    }
    if (auctionFetchDue(state, task.due, now) > now) {
      await this.rearm();
      return;
    }
    const needsRobots = !state.robots || now - state.robots.observedAt > 24 * 60 * 60_000;
    const url = needsRobots ? `${YAHOO_AUCTION_ORIGIN}/robots.txt` : auctionTaskUrl(task);
    if (!needsRobots && state.robots && !auctionRobotsPermit(state.robots.text, url).allowed) {
      this.store.saveRuntime({ ...state, halt: "robots_disallowed" });
      return;
    }
    // Includes worst-case 20 item/page indexes, commit, receipt, task, Alarm and metering overhead.
    const reserved = reserveAuctionBudget(
      state,
      {
        ...emptyAuctionCharge(),
        requests: 0,
        sellerRequests: 1,
        pages: !needsRobots && task.kind === "discover" ? 1 : 0,
        newItems: !needsRobots && task.kind === "discover" ? 20 : 0,
        reads: 5_000,
        writes: needsRobots ? 20 : 2_000,
        durationGbSeconds: 4,
      },
      now,
      task.kind === "confirm",
    );
    if (!reserved) {
      // A soft discovery ceiling does not consume the confirmation/recovery opportunity.
      this.store.storage.transactionSync(() => {
        this.store.saveRuntime({ ...state, lastFailure: "budget_exhausted", lastKind: task.kind });
        this.store.task({
          ...task,
          due: (Math.max(state.utcDay, Math.floor(now / 86_400_000)) + 1) * 86_400_000,
        });
      });
      await this.rearm();
      return;
    }
    state = {
      ...reserved,
      sequence: state.sequence + 1,
      lastKind: task.kind,
      nextFetchAt: now + Math.max(60_000, state.robots?.delayMs ?? 0),
    };
    const issued = {
      ...task,
      sequence: state.sequence,
      due: now + 120_000,
      attempts: task.attempts + 1,
    };
    const generation = state.generation;
    this.store.storage.transactionSync(() => {
      this.store.saveRuntime(state);
      this.store.task(issued);
    });
    // Establish a recovery wake before network I/O. A lost wake is repaired through admin wake.
    await this.rearm();
    let response;
    try {
      response = await this.transport.request(url, needsRobots);
    } catch {
      response = { status: null, text: null, retryAfter: null, authenticationRequired: false };
    }
    const completedAt = this.clock();
    this.store.storage.transactionSync(() => {
      const current = this.store.runtime(completedAt);
      const pending = this.store.getTask(task.id);
      if (
        current.generation !== generation ||
        current.paused ||
        !current.categories.includes(task.categoryId) ||
        !pending ||
        pending.sequence !== issued.sequence
      )
        return;
      const receipt = `${generation}:${issued.sequence}`;
      if (this.store.receipt(receipt)) return;
      const policy = yahooAuctionFetchPolicy(response.status, response.authenticationRequired);
      if (policy !== "parse" || response.text === null) {
        this.failure(current, issued, policy, completedAt, response.retryAfter);
        return;
      }
      if (needsRobots) {
        const permit = auctionRobotsPermit(response.text, auctionTaskUrl(task));
        if (!permit.allowed) {
          this.failure(current, issued, "halt", completedAt, null);
          return;
        }
        this.store.saveRuntime({
          ...current,
          robots: { text: response.text, observedAt: completedAt, delayMs: permit.delayMs },
          throttleCount: 0,
          nextFetchAt: Math.max(current.nextFetchAt, completedAt + permit.delayMs),
        });
        this.store.task({ ...task, sequence: null, due: completedAt + permit.delayMs });
        this.store.commitReceipt(receipt, completedAt, "unknown");
        return;
      }
      const page = this.source.parse(response.text, {
        generation,
        sequence: issued.sequence,
        observedAt: new Date(now).toISOString(),
        categoryId: task.categoryId,
      });
      if (
        page.status === "unsupported" ||
        page.observations.length > 20 ||
        page.observations.some(
          (item) =>
            item.item.sourceCategoryId !== task.categoryId ||
            item.stamp.generation !== generation ||
            item.stamp.sequence !== issued.sequence ||
            item.stamp.observedAt !== new Date(now).toISOString() ||
            (task.kind === "confirm" && item.auctionId !== task.auctionId),
        )
      ) {
        this.store.saveRuntime({
          ...current,
          halt: "source_contract_unknown",
          coverage: "unknown",
        });
        return;
      }
      let retained = this.store.sql<{ n: number }>(
        "item",
        "SELECT count(*) n FROM auction_items",
      )[0].n;
      for (const observation of page.observations) {
        const exists = !!this.store.item(observation.auctionId);
        if (!this.store.apply(observation, retained)) continue;
        if (!exists) retained++;
        if (task.kind === "discover" && !this.store.getTask(`confirm:${observation.auctionId}`))
          this.store.task({
            id: `confirm:${observation.auctionId}`,
            kind: "confirm",
            categoryId: task.categoryId,
            auctionId: observation.auctionId,
            page: 1,
            due: completedAt + 60 * 60_000,
            attempts: 0,
            sequence: null,
          });
      }
      this.store.commitReceipt(receipt, completedAt, page.coverage);
      const merged = task.auctionId ? this.store.item(task.auctionId)?.snapshot : null;
      const end = merged?.live.scheduledEndAt?.value;
      const endChecks =
        task.kind === "confirm" && end && Date.parse(end) <= completedAt
          ? (task.endChecks ?? 0) + 1
          : 0;
      if (task.kind === "confirm" && merged?.live.sourceState?.value === "ended")
        this.store.sql("task", "DELETE FROM auction_tasks WHERE id=?", task.id);
      else
        this.store.task({
          ...task,
          sequence: null,
          attempts: 0,
          endChecks,
          page: task.kind === "discover" ? (task.page % AUCTION_PAGE_LIMIT) + 1 : 1,
          due:
            endChecks >= 8
              ? Number.MAX_SAFE_INTEGER
              : completedAt +
                (task.kind === "discover" && task.page < AUCTION_PAGE_LIMIT
                  ? 60_000
                  : task.kind === "confirm" && end && Date.parse(end) - completedAt < 60 * 60_000
                    ? 30 * 60_000
                    : 60 * 60_000),
        });
      this.store.saveRuntime({
        ...current,
        coverage: "partial",
        lastSuccessAt: new Date(now).toISOString(),
        lastFailure: null,
        throttleCount: 0,
      });
    });
    this.store.retain(completedAt);
    await this.rearm();
  }

  private failure(
    state: AuctionRuntimeState,
    task: AuctionTask,
    policy: string,
    now: number,
    retryAfter: string | null,
  ): void {
    const throttles = state.throttleCount + (policy === "backoff" ? 1 : 0);
    const due = auctionRetryAt(task.attempts, now, retryAfter);
    const halt =
      policy === "halt" || throttles >= 3 || due > now + 30 * 86_400_000
        ? "source_blocked"
        : state.halt;
    this.store.saveRuntime({
      ...state,
      halt,
      throttleCount: throttles,
      lastFailure: policy,
      coverage: "unknown",
      backoffUntil: policy === "backoff" ? due : state.backoffUntil,
    });
    if (task.attempts >= AUCTION_MAX_ATTEMPTS) {
      // Retain the dead task visibly, with no automatically recurring retry loop.
      this.store.task({ ...task, sequence: null, due: Number.MAX_SAFE_INTEGER });
    } else this.store.task({ ...task, sequence: null, due });
  }
}
