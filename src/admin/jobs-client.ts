import { parseAdminJobCommand } from "../http/admin-jobs.js";

export async function requestAdminJobs(env: Env, input: unknown): Promise<unknown> {
  const command = parseAdminJobCommand(input);
  if (!command) throw new Error("invalid_admin_job_command");
  const stub = env.ADMIN_JOBS.get(env.ADMIN_JOBS.idFromName("admin-jobs"));
  const response = await stub.fetch("https://admin-jobs.internal/command", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(command),
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
