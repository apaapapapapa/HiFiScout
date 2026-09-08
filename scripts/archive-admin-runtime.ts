import { SqlObservationClient } from "./lib/d1-sql-observation-client.js";
import { buildRuntimeSnapshot } from "./lib/admin-runtime-snapshot.js";

try {
  const client = new SqlObservationClient({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
    apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
  });
  const snapshot = await buildRuntimeSnapshot(client, async (path) => {
    const response = await fetch(`https://api.github.com/repos/apaapapapapa/HiFiScout/${path}`, {
      headers: {
        Authorization: `Bearer ${process.env.GH_TOKEN ?? ""}`,
        Accept: "application/vnd.github+json",
      },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1024 * 1024) {
      await response.body?.cancel();
      throw new Error("github_snapshot_unavailable");
    }
    return response.json();
  });
  await client.saveAdminSnapshot("runtime", snapshot);
  console.log(
    JSON.stringify({
      event: "admin_runtime_snapshot",
      generatedAt: snapshot.generatedAt,
      unavailableWorkers: snapshot.workerStats
        .filter((row) => !row.available)
        .map((row) => row.worker),
      deploymentAvailable: !!snapshot.deployment,
    }),
  );
  if (snapshot.workerStats.some((row) => !row.available) || !snapshot.deployment)
    process.exitCode = 1;
} catch {
  console.error("Admin runtime snapshot failed; no responses or credentials were logged.");
  process.exitCode = 1;
}
