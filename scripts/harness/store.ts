import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../../src/types.js";

// Shared by evidence checkpoints and loop journals. A surviving lock is deliberately not stolen:
// an operator must first establish that its writer is no longer alive.
export async function updateJsonRevision<T extends { revision: number }>(
  path: string,
  expectedRevision: number,
  parse: (value: unknown) => T,
  update: (previous: T | null) => T,
): Promise<T> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new Error("invalid_expected_revision");
  await mkdir(dirname(path), { recursive: true });
  const lockPath = `${path}.lock`;
  const lock = await open(lockPath, "wx", 0o600);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    let previous: T | null = null;
    try {
      previous = parse(JSON.parse(await readFile(path, "utf8")));
    } catch (error) {
      if (!isRecord(error) || error.code !== "ENOENT") throw error;
    }
    if ((previous?.revision ?? 0) !== expectedRevision)
      throw new Error("checkpoint_revision_conflict");
    const next = parse(update(previous));
    if (next.revision !== expectedRevision + 1) throw new Error("invalid_next_revision");
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
    return next;
  } finally {
    await rm(temporary, { force: true });
    await lock.close();
    await rm(lockPath, { force: true });
  }
}
