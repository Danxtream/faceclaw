import { type ImageTile } from "./image";

const lz4 = require("lz4js");
const pako = require("pako");

type CompressionTotals = {
  uncompressed: number;
  lz4: number;
  png: number;
};

export type CompressionEstimateReport = {
  tileLines: string[];
  totalLine: string;
};

const cumulativeTotals: CompressionTotals = {
  uncompressed: 0,
  lz4: 0,
  png: 0,
};

let reportSequence = 0;

export function estimateTileCompression(tiles: readonly ImageTile[]): CompressionEstimateReport {
  const frameTotals: CompressionTotals = {
    uncompressed: 0,
    lz4: 0,
    png: 0,
  };
  const frameId = ++reportSequence;
  const tileLines: string[] = [];

  for (let index = 0; index < tiles.length; index++) {
    const tile = tiles[index]!;
    const uncompressedSize = tile.bmp.byteLength;
    const lz4Size = byteLength(lz4.compress(tile.bmp));
    const pngSize = encodePng4BitGrayscaleFromBmpTile(tile).byteLength;

    frameTotals.uncompressed += uncompressedSize;
    frameTotals.lz4 += lz4Size;
    frameTotals.png += pngSize;

    tileLines.push(
      `compression estimate #${frameId} tile ${index + 1}/${tiles.length} ` +
        `${tile.x},${tile.y} ${tile.width}x${tile.height}: ` +
        `uncompressed=${uncompressedSize}, lz4=${formatSizeWithRatio(lz4Size, uncompressedSize)}, ` +
        `png4=${formatSizeWithRatio(pngSize, uncompressedSize)}`,
    );
  }

  cumulativeTotals.uncompressed += frameTotals.uncompressed;
  cumulativeTotals.lz4 += frameTotals.lz4;
  cumulativeTotals.png += frameTotals.png;

  return {
    tileLines,
    totalLine:
      `compression estimate #${frameId} totals: ` +
      `frame uncompressed=${frameTotals.uncompressed}, ` +
      `lz4=${formatSizeWithRatio(frameTotals.lz4, frameTotals.uncompressed)}, ` +
      `png4=${formatSizeWithRatio(frameTotals.png, frameTotals.uncompressed)}; ` +
      `running uncompressed=${cumulativeTotals.uncompressed}, ` +
      `lz4=${formatSizeWithRatio(cumulativeTotals.lz4, cumulativeTotals.uncompressed)}, ` +
      `png4=${formatSizeWithRatio(cumulativeTotals.png, cumulativeTotals.uncompressed)}`,
  };
}

function encodePng4BitGrayscaleFromBmpTile(tile: ImageTile): Uint8Array {
  const pixelOffset = readUint32Le(tile.bmp, 10);
  const sourceStride = (((tile.width + 1) >> 1) + 3) & ~3;
  const pngRowBytes = (tile.width + 1) >> 1;
  const scanlineStride = 1 + pngRowBytes;
  const scanlines = new Uint8Array(scanlineStride * tile.height);

  for (let y = 0; y < tile.height; y++) {
    const sourceY = tile.height - 1 - y;
    const sourceOffset = pixelOffset + sourceY * sourceStride;
    const targetOffset = y * scanlineStride;
    scanlines[targetOffset] = 0; // PNG filter type 0 keeps the 4-bit samples unchanged.
    scanlines.set(tile.bmp.subarray(sourceOffset, sourceOffset + pngRowBytes), targetOffset + 1);
  }

  const compressed = toUint8Array(pako.deflate(scanlines));
  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, tile.width, false);
  ihdrView.setUint32(4, tile.height, false);
  ihdr[8] = 4; // bit depth: 4-bit grayscale
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0; // compression method
  ihdr[11] = 0; // filter method
  ihdr[12] = 0; // no interlace

  return concatBytes(
    PNG_SIGNATURE,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", compressed),
    pngChunk("IEND", new Uint8Array(0)),
  );
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = asciiBytes(type);
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength, false);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.byteLength, crc32(typeBytes, data), false);
  return chunk;
}

const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = buildCrcTable();

function crc32(typeBytes: Uint8Array, data: Uint8Array): number {
  let crc = 0xffffffff;
  crc = updateCrc32(crc, typeBytes);
  crc = updateCrc32(crc, data);
  return (crc ^ 0xffffffff) >>> 0;
}

function updateCrc32(crc: number, data: Uint8Array): number {
  for (let i = 0; i < data.byteLength; i++) {
    crc = CRC_TABLE[(crc ^ data[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return crc;
}

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < table.length; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function asciiBytes(value: string): Uint8Array {
  const out = new Uint8Array(value.length);
  for (let i = 0; i < value.length; i++) {
    out[i] = value.charCodeAt(i) & 0x7f;
  }
  return out;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const totalLength = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function readUint32Le(bytes: Uint8Array, offset: number): number {
  return (
    (bytes[offset] ?? 0) |
    ((bytes[offset + 1] ?? 0) << 8) |
    ((bytes[offset + 2] ?? 0) << 16) |
    ((bytes[offset + 3] ?? 0) << 24)
  ) >>> 0;
}

function byteLength(value: ArrayLike<number> | Uint8Array): number {
  return value instanceof Uint8Array ? value.byteLength : value.length;
}

function toUint8Array(value: ArrayLike<number> | Uint8Array): Uint8Array {
  return value instanceof Uint8Array ? value : Uint8Array.from(value);
}

function formatSizeWithRatio(size: number, uncompressedSize: number): string {
  if (uncompressedSize <= 0) return `${size}`;
  return `${size} (${((size / uncompressedSize) * 100).toFixed(1)}%)`;
}
