import { parseAdminJobCommand } from "../http/admin-jobs.js";
import { UNKNOWN_ADMIN_ACTOR, trustedActor } from "../api/admin-actor.js";

export async function requestAdminJobs(
  env: Env,
  input: unknown,
  actor = UNKNOWN_ADMIN_ACTOR,
): Promise<unknown> {
  const command = parseAdminJobCommand(input);
  if (!command) throw new Error("invalid_admin_job_command");
  const stub = env.ADMIN_JOBS.get(env.ADMIN_JOBS.idFromName("admin-jobs"));
  // The subject travels beside the parsed command, never inside it: `parseAdminJobCommand` rejects
  // unknown keys, so a request body cannot smuggle an actor in and have it stored as one.
  const response = await stub.fetch("https://admin-jobs.internal/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command, actor: trustedActor(actor) }),
  });
  const result: unknown = await response.json();
  if (!response.ok)
    throw new Error(
      result && typeof result === "object" && "error" in result
        ? String(result.error)
        : "background_jobs_unavailable",
    );
  return result;
}
