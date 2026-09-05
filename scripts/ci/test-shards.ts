export interface WeightedTest {
  id: string;
  weight: number;
}

/** Greedy longest-first assignment; every file appears exactly once, including new/unmeasured tests. */
export function partitionTests(tests: WeightedTest[], count: number): string[][] {
  if (!Number.isInteger(count) || count < 1) throw new Error("Invalid shard count.");
  const shards = Array.from({ length: count }, () => ({ load: 0, files: [] as string[] }));
  const ordered = [...tests].sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id, "en"));
  for (const test of ordered) {
    const target = shards.reduce((best, shard) =>
      shard.load < best.load || (shard.load === best.load && shard.files.length < best.files.length)
        ? shard
        : best,
    );
    target.files.push(test.id);
    target.load += Math.max(1, test.weight);
  }
  return shards.map((shard) => shard.files);
}
