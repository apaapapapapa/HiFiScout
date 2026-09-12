import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";
import { ensureStoredCsvChunk } from "../src/export/stored-csv-chunk.js";

const exportFixtures = [
  {
    kind: "product_audit_export",
    metadata: { maxListingId: 30, scope: "active" },
    mismatchedMetadata: { maxListingId: "31", scope: "all" },
  },
  {
    kind: "knowledge_catalog_export",
    metadata: { maxCatalogProductId: 30 },
    mismatchedMetadata: { maxCatalogProductId: "31" },
  },
] as const;

for (const fixture of exportFixtures) {
  function arrange() {
    const key = `${fixture.kind}/job/00000001.csv`;
    // This is the pre-refactor persisted metadata format, including its domain-specific keys.
    const object = {
      key,
      size: 42,
      version: "test-version",
      etag: "test-etag",
      httpEtag: '"test-etag"',
      checksums: { toJSON: () => ({}) },
      uploaded: new Date("2026-09-12T00:00:00.000Z"),
      storageClass: "Standard",
      writeHttpMetadata() {},
      customMetadata: {
        version: "1",
        ...Object.fromEntries(
          Object.entries(fixture.metadata).map(([name, value]) => [name, String(value)]),
        ),
        afterId: "10",
        chunkIndex: "1",
        nextAfterId: "20",
        rowCount: "2",
        hasMore: "1",
      },
    } satisfies R2Object;
    const options = {
      key,
      kind: fixture.kind,
      cursor: { expectedAfterId: 10, expectedChunkCount: 1 },
      maxId: 30,
      metadata: fixture.metadata,
      loadPage: vi.fn(async () => ({ items: [{ id: 30 }], nextAfterId: null })),
      rowId: (row: { id: number }) => row.id,
      encode: vi.fn(() => new TextEncoder().encode("changed source rows")),
    };
    return { object, options };
  }

  test(`${fixture.kind}: a persisted chunk is reused without rereading or re-encoding source rows`, async () => {
    const { object, options } = arrange();
    const put = vi.fn(async () => null);
    const bucket = { head: async () => object, put } as unknown as R2Bucket;
    const result = await ensureStoredCsvChunk(bucket, options);
    assert.deepEqual(result, {
      key: object.key,
      nextAfterId: 20,
      rowCount: 2,
      byteCount: 42,
      hasMore: true,
    });
    assert.equal(options.loadPage.mock.calls.length, 0);
    assert.equal(options.encode.mock.calls.length, 0);
    assert.equal(put.mock.calls.length, 0);
  });

  test(`${fixture.kind}: a conditional-write loser adopts the winning cursor and counters`, async () => {
    const { object, options } = arrange();
    const head = vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(object);
    const put = vi.fn(async (_key: string, _bytes: unknown, writeOptions?: R2PutOptions) => {
      assert.deepEqual(writeOptions?.onlyIf, { etagDoesNotMatch: "*" });
      assert.equal(writeOptions?.customMetadata?.nextAfterId, "30");
      return null;
    });
    const bucket = { head, put } as unknown as R2Bucket;
    const result = await ensureStoredCsvChunk(bucket, options);
    assert.deepEqual(result, {
      key: object.key,
      nextAfterId: 20,
      rowCount: 2,
      byteCount: 42,
      hasMore: true,
    });
    assert.equal(options.loadPage.mock.calls.length, 1);
    assert.equal(put.mock.calls.length, 1);
    assert.equal(head.mock.calls.length, 2);
  });

  test(`${fixture.kind}: mismatched or corrupt persisted metadata never advances or rereads a page`, async () => {
    const corruptions: Record<string, string>[] = [
      ...Object.entries(fixture.mismatchedMetadata).map(([key, value]) => ({ [key]: value })),
      { afterId: "11" },
      { chunkIndex: "2" },
      { rowCount: "NaN" },
      { nextAfterId: "10" },
      { nextAfterId: "31" },
      { hasMore: "true" },
      { version: "2" },
    ];
    for (const corruption of corruptions) {
      const { object, options } = arrange();
      const corruptedObject: R2Object = {
        ...object,
        customMetadata: { ...object.customMetadata, ...corruption },
      };
      const put = vi.fn(async () => null);
      const bucket = { head: async () => corruptedObject, put } as unknown as R2Bucket;
      await assert.rejects(ensureStoredCsvChunk(bucket, options), {
        message: `${fixture.kind}_chunk_metadata_invalid:${object.key}`,
      });
      assert.equal(options.loadPage.mock.calls.length, 0);
      assert.equal(put.mock.calls.length, 0);
    }
  });
}
