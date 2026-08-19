package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.util.ArrayList;
import java.util.List;

/**
 * Buffered Annex-B H.264 reader for long recordings.
 *
 * Normal playback keeps only a 256 KiB read-ahead buffer plus the current NAL.
 * Seeking scans start codes/NAL headers natively without materializing the file.
 */
public final class H264StreamingReader implements AutoCloseable {
    public static final int BUFFER_SIZE = 256 * 1024;
    private static final int SCAN_BUFFER_SIZE = 1024 * 1024;
    private static final int MAX_NAL_SIZE = 16 * 1024 * 1024;

    public static final class Nal {
        private final byte[] bytes;
        private final int type;
        private final long startOffset;

        Nal(byte[] bytes, int type, long startOffset) {
            this.bytes = bytes;
            this.type = type;
            this.startOffset = startOffset;
        }

        public byte[] getBytes() {
            return bytes;
        }

        public int getType() {
            return type;
        }

        public long getStartOffset() {
            return startOffset;
        }
    }

    public static final class SeekPoint {
        private final long byteOffset;
        private final long frameIndex;
        private final boolean reachedTarget;

        SeekPoint(long byteOffset, long frameIndex, boolean reachedTarget) {
            this.byteOffset = byteOffset;
            this.frameIndex = frameIndex;
            this.reachedTarget = reachedTarget;
        }

        public long getByteOffset() {
            return byteOffset;
        }

        public long getFrameIndex() {
            return frameIndex;
        }

        public boolean getReachedTarget() {
            return reachedTarget;
        }
    }

    private final File sourceFile;
    private final RandomAccessFile file;
    private static final class IndexEntry {
        final long byteOffset;
        final long frameIndex;

        IndexEntry(long byteOffset, long frameIndex) {
            this.byteOffset = byteOffset;
            this.frameIndex = frameIndex;
        }
    }

    private final byte[] buffer = new byte[BUFFER_SIZE];
    private final List<IndexEntry> idrIndex = new ArrayList<>();
    private long indexedThroughFrame = -1;

    private long bufferStart = 0;
    private int bufferPos = 0;
    private int bufferLimit = 0;
    private boolean pendingStartCode = false;
    private long pendingStartOffset = -1;
    private boolean closed = false;

    public H264StreamingReader(String absolutePath) throws IOException {
        sourceFile = new File(absolutePath);
        if (!sourceFile.isFile()) {
            throw new IOException("H.264 file does not exist: " + absolutePath);
        }
        file = new RandomAccessFile(sourceFile, "r");
        seekToOffset(0);
    }

    public synchronized long getFileLength() {
        return sourceFile.length();
    }

    public synchronized int getBufferSize() {
        return BUFFER_SIZE;
    }

    public synchronized void seekToOffset(long offset) throws IOException {
        ensureOpen();
        long safe = Math.max(0, Math.min(sourceFile.length(), offset));
        file.seek(safe);
        bufferStart = safe;
        bufferPos = 0;
        bufferLimit = 0;
        pendingStartCode = false;
        pendingStartOffset = -1;
    }

    public synchronized Nal nextNal() throws IOException {
        ensureOpen();

        while (true) {
            long nalStartOffset;
            if (pendingStartCode) {
                nalStartOffset = pendingStartOffset;
                pendingStartCode = false;
                pendingStartOffset = -1;
            } else {
                nalStartOffset = findAndConsumeStartCode();
                if (nalStartOffset < 0) return null;
            }

            ByteArrayOutputStream out = new ByteArrayOutputStream(4096);
            int zeros = 0;
            boolean hitNextStart = false;

            while (true) {
                int value = readByte();
                if (value < 0) {
                    for (int i = 0; i < zeros; i++) out.write(0);
                    break;
                }

                long byteOffset = currentPosition() - 1;
                if (value == 0) {
                    zeros++;
                    continue;
                }

                if (value == 1 && zeros >= 2) {
                    pendingStartCode = true;
                    pendingStartOffset = byteOffset - zeros;
                    hitNextStart = true;
                    break;
                }

                for (int i = 0; i < zeros; i++) out.write(0);
                zeros = 0;
                out.write(value);

                if (out.size() > MAX_NAL_SIZE) {
                    throw new IOException("H.264 NAL exceeds safety limit at byte " + nalStartOffset);
                }
            }

            byte[] bytes = out.toByteArray();
            if (bytes.length == 0) {
                if (!hitNextStart) return null;
                continue;
            }

            return new Nal(bytes, bytes[0] & 0x1f, nalStartOffset);
        }
    }

    /**
     * Find the nearest IDR at or before targetFrame. The first far seek scans
     * start codes/NAL headers natively and remembers only IDR byte offsets in
     * RAM. Later seeks within the already-scanned region are immediate; seeks
     * farther ahead continue from the latest cached IDR instead of rescanning
     * the file from byte zero.
     */
    public synchronized SeekPoint findSeekPoint(long targetFrame) throws IOException {
        ensureOpen();
        long target = Math.max(0, targetFrame);
        if (target == 0) return new SeekPoint(0, 0, true);

        if (target <= indexedThroughFrame) {
            IndexEntry cached = cachedIdrAtOrBefore(target);
            return new SeekPoint(
                cached != null ? cached.byteOffset : 0,
                cached != null ? cached.frameIndex : 0,
                true
            );
        }

        IndexEntry resume = idrIndex.isEmpty() ? null : idrIndex.get(idrIndex.size() - 1);
        long scanStartOffset = resume != null ? resume.byteOffset : 0;
        long frameIndex = resume != null ? resume.frameIndex : 0;

        try (RandomAccessFile scan = new RandomAccessFile(sourceFile, "r")) {
            scan.seek(scanStartOffset);
            byte[] scanBuffer = new byte[SCAN_BUFFER_SIZE];
            long absoluteBase = scanStartOffset;
            int zeros = 0;
            boolean expectNalHeader = false;
            long currentStartOffset = scanStartOffset;

            while (true) {
                int count = scan.read(scanBuffer);
                if (count < 0) break;
                if (count == 0) continue;

                for (int i = 0; i < count; i++) {
                    int value = scanBuffer[i] & 0xff;
                    long absoluteOffset = absoluteBase + i;

                    if (expectNalHeader) {
                        int type = value & 0x1f;
                        expectNalHeader = false;
                        zeros = 0;

                        if (type == 1 || type == 5) {
                            if (type == 5) cacheIdr(currentStartOffset, frameIndex);

                            if (frameIndex >= target) {
                                indexedThroughFrame = Math.max(indexedThroughFrame, target);
                                IndexEntry best = cachedIdrAtOrBefore(target);
                                return new SeekPoint(
                                    best != null ? best.byteOffset : 0,
                                    best != null ? best.frameIndex : 0,
                                    true
                                );
                            }
                            frameIndex++;
                        }
                        continue;
                    }

                    if (value == 0) {
                        zeros++;
                        continue;
                    }

                    if (value == 1 && zeros >= 2) {
                        currentStartOffset = absoluteOffset - zeros;
                        expectNalHeader = true;
                        zeros = 0;
                        continue;
                    }

                    zeros = 0;
                }

                absoluteBase += count;
            }
        }

        indexedThroughFrame = Math.max(indexedThroughFrame, Math.max(0, frameIndex - 1));
        IndexEntry best = cachedIdrAtOrBefore(target);
        return new SeekPoint(
            best != null ? best.byteOffset : 0,
            best != null ? best.frameIndex : 0,
            false
        );
    }

    private void cacheIdr(long byteOffset, long frameIndex) {
        if (!idrIndex.isEmpty()) {
            IndexEntry last = idrIndex.get(idrIndex.size() - 1);
            if (last.frameIndex == frameIndex && last.byteOffset == byteOffset) return;
            if (last.frameIndex > frameIndex) return;
        }
        idrIndex.add(new IndexEntry(byteOffset, frameIndex));
    }

    private IndexEntry cachedIdrAtOrBefore(long targetFrame) {
        if (idrIndex.isEmpty()) return null;
        int low = 0;
        int high = idrIndex.size() - 1;
        IndexEntry best = null;
        while (low <= high) {
            int mid = (low + high) >>> 1;
            IndexEntry entry = idrIndex.get(mid);
            if (entry.frameIndex <= targetFrame) {
                best = entry;
                low = mid + 1;
            } else {
                high = mid - 1;
            }
        }
        return best;
    }

    public long countFrames() throws IOException {
        long frameCount = 0;

        try (RandomAccessFile scan = new RandomAccessFile(sourceFile, "r")) {
            byte[] scanBuffer = new byte[SCAN_BUFFER_SIZE];
            int zeros = 0;
            boolean expectNalHeader = false;

            while (true) {
                int count = scan.read(scanBuffer);
                if (count < 0) break;
                if (count == 0) continue;

                for (int i = 0; i < count; i++) {
                    int value = scanBuffer[i] & 0xff;

                    if (expectNalHeader) {
                        int type = value & 0x1f;
                        expectNalHeader = false;
                        zeros = 0;
                        if (type == 1 || type == 5) frameCount++;
                        continue;
                    }

                    if (value == 0) {
                        zeros++;
                    } else if (value == 1 && zeros >= 2) {
                        expectNalHeader = true;
                        zeros = 0;
                    } else {
                        zeros = 0;
                    }
                }
            }
        }

        return frameCount;
    }

    @Override
    public synchronized void close() throws IOException {
        if (closed) return;
        closed = true;
        file.close();
    }

    private long findAndConsumeStartCode() throws IOException {
        int zeros = 0;
        while (true) {
            int value = readByte();
            if (value < 0) return -1;
            long byteOffset = currentPosition() - 1;

            if (value == 0) {
                zeros++;
            } else if (value == 1 && zeros >= 2) {
                return byteOffset - zeros;
            } else {
                zeros = 0;
            }
        }
    }

    private int readByte() throws IOException {
        if (bufferPos >= bufferLimit) {
            bufferStart = file.getFilePointer();
            bufferLimit = file.read(buffer);
            bufferPos = 0;
            if (bufferLimit < 0) return -1;
        }
        return buffer[bufferPos++] & 0xff;
    }

    private long currentPosition() {
        return bufferStart + bufferPos;
    }

    private void ensureOpen() throws IOException {
        if (closed) throw new IOException("H.264 reader is closed");
    }
}
