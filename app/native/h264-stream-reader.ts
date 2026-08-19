declare const com: any;

export type H264StreamNal = {
  nal: Uint8Array;
  type: number;
  startOffset: number;
};

export type H264SeekPoint = {
  byteOffset: number;
  frameIndex: number;
  reachedTarget: boolean;
};

function copyJavaBytes(bytes: any): Uint8Array {
  const length = Number(bytes.length);
  const result = new Uint8Array(length);
  for (let i = 0; i < length; i++) result[i] = Number(bytes[i]) & 0xff;
  return result;
}

/**
 * Native-backed long-file Annex-B reader.
 *
 * The Java side owns a 256 KiB read-ahead buffer. Only the current NAL crosses
 * the NativeScript bridge, so multi-hour H264 files are never materialized in
 * JavaScript memory.
 */
export class H264BufferedReader {
  private readonly reader: any;
  private closed = false;

  constructor(readonly filePath: string) {
    if (!filePath.startsWith("/")) {
      throw new Error("Long H264 streaming requires an absolute Android file path");
    }
    this.reader = new com.faceclaw.app.H264StreamingReader(filePath);
  }

  get fileLength(): number {
    return Number(this.reader.getFileLength());
  }

  get bufferSize(): number {
    return Number(this.reader.getBufferSize());
  }

  seekToOffset(byteOffset: number): void {
    this.ensureOpen();
    this.reader.seekToOffset(Math.max(0, Math.floor(byteOffset)));
  }

  nextNal(): H264StreamNal | null {
    this.ensureOpen();
    const nativeNal = this.reader.nextNal();
    if (nativeNal === null) return null;
    return {
      nal: copyJavaBytes(nativeNal.getBytes()),
      type: Number(nativeNal.getType()),
      startOffset: Number(nativeNal.getStartOffset()),
    };
  }

  findSeekPoint(targetFrame: number): H264SeekPoint {
    this.ensureOpen();
    const point = this.reader.findSeekPoint(Math.max(0, Math.floor(targetFrame)));
    return {
      byteOffset: Number(point.getByteOffset()),
      frameIndex: Number(point.getFrameIndex()),
      reachedTarget: Boolean(point.getReachedTarget()),
    };
  }

  countFrames(): number {
    this.ensureOpen();
    return Number(this.reader.countFrames());
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
  }

  private ensureOpen(): void {
    if (this.closed) throw new Error("H264 buffered reader is closed");
  }
}
