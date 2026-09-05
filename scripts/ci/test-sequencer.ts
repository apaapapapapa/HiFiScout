import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { BaseSequencer } from "vite-plus/test/node";
import type { TestSpecification } from "vite-plus/test/node";
import { partitionTests } from "./test-shards.js";

const measured = JSON.parse(
  readFileSync(new URL("../../.github/config/unit-test-weights.json", import.meta.url), "utf8"),
) as Record<string, number>;

export default class BalancedSequencer extends BaseSequencer {
  private id(specification: TestSpecification): string {
    return relative(this.ctx.config.root, specification.moduleId).replaceAll("\\", "/");
  }

  override async sort(specifications: TestSpecification[]): Promise<TestSpecification[]> {
    // Start the expensive D1/Miniflare files early instead of leaving one at the end of a shard.
    return [...specifications].sort(
      (a, b) =>
        (measured[this.id(b)] ?? 250) - (measured[this.id(a)] ?? 250) ||
        this.id(a).localeCompare(this.id(b), "en"),
    );
  }

  override async shard(specifications: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return specifications;
    const ids = new Map(
      specifications.map((specification) => [this.id(specification), specification]),
    );
    const partitions = partitionTests(
      [...ids.keys()].map((id) => ({
        id,
        // Include per-file isolation/import overhead, even when its assertions are nearly instant.
        weight: (measured[id] ?? 250) + 150,
      })),
      shard.count,
    );
    return partitions[shard.index - 1].map((id) => ids.get(id)!);
  }
}
