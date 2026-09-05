/** Minimal Node-side stand-in for Cloudflare's runtime-only exports. */
export const env: Record<string, unknown> = {};

export class DurableObject<Env = unknown> {
  constructor(
    public readonly ctx: DurableObjectState,
    public readonly env: Env,
  ) {}
}

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public readonly ctx: ExecutionContext,
    public readonly env: Env,
  ) {}
}
