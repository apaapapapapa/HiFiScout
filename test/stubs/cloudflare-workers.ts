/** Minimal Node-side stand-in for Cloudflare's runtime-only exports. */
export const env: Record<string, unknown> = {};

export class WorkerEntrypoint<Env = unknown> {
  constructor(
    public readonly ctx: ExecutionContext,
    public readonly env: Env,
  ) {}
}
