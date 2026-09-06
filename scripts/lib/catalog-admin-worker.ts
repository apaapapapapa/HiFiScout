export interface CloudflareWorker {
  id?: string;
  name?: string;
}

/** Confirm absence only after the final page; an API error must never trigger a bootstrap deploy. */
export async function findCatalogAdminWorkerId(
  workerName: string,
  readPage: (page: number) => Promise<CloudflareWorker[]>,
): Promise<string | null> {
  for (let page = 1; page <= 100; page += 1) {
    const workers = await readPage(page);
    const worker = workers.find((candidate) => candidate.name === workerName);
    if (worker) {
      if (!worker.id) throw new Error(`Cloudflare Worker has no id: ${workerName}`);
      return worker.id;
    }
    if (workers.length < 100) return null;
  }
  throw new Error("Cloudflare Worker enumeration exceeded its page budget");
}
