export type ZipEntry = {
  name: string;
  size: number;
  open: () => AsyncIterable<Uint8Array>;
};

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function crc32Update(crc: number, bytes: Uint8Array) {
  for (const byte of bytes) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return crc >>> 0;
}

function zipName(value: string, index: number) {
  const basename = value.replaceAll("\\", "/").split("/").at(-1) ?? "";
  let safe = basename.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "_").trim() || "foto";
  let name = `${String(index + 1).padStart(3, "0")}-${safe}`;
  while (Buffer.byteLength(name, "utf8") > 255) {
    safe = safe.slice(0, -1);
    name = `${String(index + 1).padStart(3, "0")}-${safe || "foto"}`;
  }
  return name;
}

function dosTimestamp(date: Date) {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

async function* zipChunks(entries: AsyncIterable<ZipEntry>, onEntryComplete?: (count: number) => void): AsyncGenerator<Uint8Array> {
  const centralDirectory: Buffer[] = [];
  let offset = 0;
  let index = 0;

  for await (const entry of entries) {
    if (index >= 0xffff || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > 0xffffffff) {
      throw new Error("O pacote ZIP excede os limites suportados.");
    }
    const filename = Buffer.from(zipName(entry.name, index), "utf8");
    const { time, date } = dosTimestamp(new Date());
    const localOffset = offset;
    const flags = 0x0808; // UTF-8 filename and data descriptor follow the file body.
    const localHeader = Buffer.alloc(30 + filename.length);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(flags, 6);
    localHeader.writeUInt16LE(0, 8); // Stored without compression to keep memory and CPU bounded.
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt16LE(filename.length, 26);
    filename.copy(localHeader, 30);
    yield localHeader;
    offset += localHeader.length;

    let crc = 0xffffffff;
    let size = 0;
    for await (const chunk of entry.open()) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > entry.size || size > 0xffffffff) throw new Error("O tamanho do arquivo mudou durante o pacote ZIP.");
      crc = crc32Update(crc, bytes);
      if (bytes.length > 0) {
        yield bytes;
        offset += bytes.length;
      }
    }
    if (size !== entry.size) throw new Error("O arquivo recebido não corresponde ao tamanho autorizado.");
    crc = (crc ^ 0xffffffff) >>> 0;

    const descriptor = Buffer.alloc(16);
    descriptor.writeUInt32LE(0x08074b50, 0);
    descriptor.writeUInt32LE(crc, 4);
    descriptor.writeUInt32LE(size, 8);
    descriptor.writeUInt32LE(size, 12);
    onEntryComplete?.(index + 1);
    yield descriptor;
    offset += descriptor.length;

    const central = Buffer.alloc(46 + filename.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(size, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(filename.length, 28);
    central.writeUInt32LE(0x81a40000, 38);
    central.writeUInt32LE(localOffset, 42);
    filename.copy(central, 46);
    centralDirectory.push(central);
    index++;
  }

  const centralOffset = offset;
  for (const entry of centralDirectory) {
    yield entry;
    offset += entry.length;
  }
  const centralSize = offset - centralOffset;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(index, 8);
  end.writeUInt16LE(index, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  yield end;
}

export function createZipStream(entries: AsyncIterable<ZipEntry>, onIncomplete?: (completedEntries: number) => Promise<void> | void) {
  let completedEntries = 0;
  let streamCompleted = false;
  let cleanupStarted = false;
  const iterator = zipChunks(entries, (count) => { completedEntries = count; })[Symbol.asyncIterator]();

  async function releaseIncompleteEntries() {
    if (streamCompleted || cleanupStarted) return;
    cleanupStarted = true;
    try { await onIncomplete?.(completedEntries); } catch { /* A failed cleanup must not hide the stream error. */ }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          streamCompleted = true;
          controller.close();
        }
        else controller.enqueue(next.value);
      } catch (error) {
        await releaseIncompleteEntries();
        controller.error(error);
      }
    },
    async cancel() {
      try { await iterator.return?.(undefined); }
      finally { await releaseIncompleteEntries(); }
    },
  });
}
