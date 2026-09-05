const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
  name: string;
  size: number;
  crc: number;
  body: ReadableStream<Uint8Array>;
}

function zipHeader(entry: ZipEntry, offset?: number): Uint8Array {
  const name = encoder.encode(entry.name);
  const central = offset !== undefined;
  if (entry.size > 0xffffffff || (offset ?? 0) > 0xffffffff)
    throw new Error("complete_export_zip32_limit");
  const bytes = new Uint8Array((central ? 46 : 30) + name.length);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, central ? 0x02014b50 : 0x04034b50, true);
  const start = central ? 6 : 4;
  if (central) view.setUint16(4, 20, true);
  view.setUint16(start, 20, true);
  view.setUint16(start + 2, 0x0800, true); // UTF-8; STORE method; deterministic DOS epoch.
  view.setUint16(start + 8, 33, true);
  view.setUint32(start + 10, entry.crc, true);
  view.setUint32(start + 14, entry.size, true);
  view.setUint32(start + 18, entry.size, true);
  view.setUint16(start + 22, name.length, true);
  if (central) view.setUint32(42, offset, true);
  bytes.set(name, central ? 46 : 30);
  return bytes;
}

/** Stored ZIP entries are streamed one object at a time. A missing/truncated object fails the
 * stream before the directory/footer, so an incomplete download cannot look like a valid archive. */
async function* zipBytes(entries: AsyncIterable<ZipEntry>): AsyncGenerator<Uint8Array> {
  const directory: Uint8Array[] = [];
  let offset = 0;
  for await (const entry of entries) {
    const header = zipHeader(entry);
    directory.push(zipHeader(entry, offset));
    yield header;
    const reader = entry.body.getReader();
    let read = 0;
    try {
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        read += result.value.byteLength;
        if (read > entry.size) throw new Error(`complete_export_object_size:${entry.name}`);
        yield result.value;
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    if (read !== entry.size) throw new Error(`complete_export_object_size:${entry.name}`);
    offset += header.byteLength + read;
  }
  const size = directory.reduce((total, bytes) => total + bytes.byteLength, 0);
  if (offset + size > 0xffffffff || directory.length > 65_535)
    throw new Error("complete_export_zip32_limit");
  for (const bytes of directory) yield bytes;
  const footer = new Uint8Array(22);
  const view = new DataView(footer.buffer);
  view.setUint32(0, 0x06054b50, true);
  view.setUint16(8, directory.length, true);
  view.setUint16(10, directory.length, true);
  view.setUint32(12, size, true);
  view.setUint32(16, offset, true);
  yield footer;
}

export function zipStream(entries: AsyncIterable<ZipEntry>): ReadableStream<Uint8Array> {
  const iterator = zipBytes(entries);
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) controller.close();
        else controller.enqueue(result.value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}
