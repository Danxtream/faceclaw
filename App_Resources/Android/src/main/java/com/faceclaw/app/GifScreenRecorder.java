package com.faceclaw.app;

import android.content.Context;

import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashMap;
import java.util.List;
import java.util.zip.DataFormatException;
import java.util.zip.Inflater;

/**
 * Accumulates composited screen frames and saves them as a looping animated
 * GIF with a 16-entry grayscale palette. Stored frames are deflate-compressed
 * (a typical UI frame shrinks from 166KB of indices to a few KB) so long
 * recordings stay affordable in memory; consecutive identical frames are
 * deduplicated, with the elapsed time folded into the next frame's delay.
 */
public final class GifScreenRecorder {
    /** Backstop against unbounded growth if a recording is left running. */
    private static final int MAX_FRAMES = 3600;
    /** Displayed duration of the final frame, which has no successor. */
    private static final int LAST_FRAME_DELAY_CS = 100;
    /** Below this, GIF renderers historically clamp or ignore the delay. */
    private static final int MIN_FRAME_DELAY_CS = 2;

    private static final class Frame {
        final byte[] deflatedIndices;
        final long timestampMs;

        Frame(byte[] deflatedIndices, long timestampMs) {
            this.deflatedIndices = deflatedIndices;
            this.timestampMs = timestampMs;
        }
    }

    private final List<Frame> frames = new ArrayList<>();
    /** Undeflated copy of the newest frame, kept for duplicate detection. */
    private byte[] lastIndices;
    private int width;
    private int height;
    private boolean overflowed;

    /**
     * Append the current screen. gray is 8bpp; only the top nibble (the
     * display's native depth, and the palette index) is kept.
     */
    public synchronized void addFrame(byte[] gray, int width, int height, long timestampMs) {
        if (gray == null || width <= 0 || height <= 0 || gray.length < width * height) {
            return;
        }
        if (frames.isEmpty()) {
            this.width = width;
            this.height = height;
        } else if (width != this.width || height != this.height) {
            return;
        }
        byte[] indices = new byte[width * height];
        for (int i = 0; i < indices.length; i++) {
            indices[i] = (byte) ((gray[i] & 0xff) >>> 4);
        }
        if (lastIndices != null && Arrays.equals(indices, lastIndices)) {
            return;
        }
        if (frames.size() >= MAX_FRAMES) {
            overflowed = true;
            return;
        }
        frames.add(new Frame(ScreenshotUtil.zlibDeflate(indices), timestampMs));
        lastIndices = indices;
    }

    /** True if frames were dropped because the recording hit MAX_FRAMES. */
    public synchronized boolean isOverflowed() {
        return overflowed;
    }

    /**
     * Encode the recording as an animated GIF in the screenshots directory.
     * Returns the absolute path, or "" if no frames were captured.
     */
    public synchronized String save(Context context) throws IOException {
        if (frames.isEmpty()) {
            return "";
        }
        File file = new File(ScreenshotUtil.ensureScreenshotsDir(context), "recording-" + ScreenshotUtil.timestamp() + ".gif");
        try (OutputStream out = new BufferedOutputStream(new FileOutputStream(file))) {
            writeGif(out);
        }
        return file.getAbsolutePath();
    }

    private void writeGif(OutputStream out) throws IOException {
        out.write('G');
        out.write('I');
        out.write('F');
        out.write('8');
        out.write('9');
        out.write('a');
        // Logical screen descriptor: global color table present, 8 bits of
        // color resolution, 2^(3+1)=16 palette entries.
        writeShortLE(out, width);
        writeShortLE(out, height);
        out.write(0x80 | 0x70 | 0x03);
        out.write(0); // background color index
        out.write(0); // pixel aspect ratio
        for (int i = 0; i < 16; i++) {
            int v = i * 17;
            out.write(v);
            out.write(v);
            out.write(v);
        }
        // Netscape application extension: loop forever.
        out.write(0x21);
        out.write(0xff);
        out.write(11);
        out.write("NETSCAPE2.0".getBytes("US-ASCII"));
        out.write(3);
        out.write(1);
        writeShortLE(out, 0);
        out.write(0);

        for (int i = 0; i < frames.size(); i++) {
            Frame frame = frames.get(i);
            // Each frame displays until the next one was captured; the last
            // frame has no successor, so give it a nominal one-second hold.
            int delayCs = LAST_FRAME_DELAY_CS;
            if (i + 1 < frames.size()) {
                long deltaMs = frames.get(i + 1).timestampMs - frame.timestampMs;
                delayCs = (int) Math.max(MIN_FRAME_DELAY_CS, Math.min(0xffff, Math.round(deltaMs / 10.0)));
            }
            // Graphic control extension: no disposal, no transparency.
            out.write(0x21);
            out.write(0xf9);
            out.write(4);
            out.write(0x04); // disposal method 1 (do not dispose)
            writeShortLE(out, delayCs);
            out.write(0); // transparent color index (unused)
            out.write(0);
            // Image descriptor: full frame, no local color table.
            out.write(0x2c);
            writeShortLE(out, 0);
            writeShortLE(out, 0);
            writeShortLE(out, width);
            writeShortLE(out, height);
            out.write(0);
            writeLzwImageData(out, inflate(frame.deflatedIndices, width * height));
        }
        out.write(0x3b); // trailer
    }

    private static byte[] inflate(byte[] deflated, int size) throws IOException {
        Inflater inflater = new Inflater();
        inflater.setInput(deflated);
        byte[] data = new byte[size];
        try {
            int offset = 0;
            while (offset < size && !inflater.finished()) {
                int n = inflater.inflate(data, offset, size - offset);
                if (n == 0) break;
                offset += n;
            }
            if (offset != size) {
                throw new IOException("recorded frame truncated: " + offset + " of " + size);
            }
        } catch (DataFormatException e) {
            throw new IOException("recorded frame corrupt", e);
        } finally {
            inflater.end();
        }
        return data;
    }

    /** GIF LZW compression of a 4-bit index stream (minimum code size 4). */
    private static void writeLzwImageData(OutputStream out, byte[] indices) throws IOException {
        final int minCodeSize = 4;
        out.write(minCodeSize);
        SubBlockBitWriter writer = new SubBlockBitWriter(out);
        final int clearCode = 1 << minCodeSize;
        final int eoiCode = clearCode + 1;
        int codeSize = minCodeSize + 1;
        int nextCode = eoiCode + 1;
        HashMap<Integer, Integer> table = new HashMap<>();
        writer.writeCode(clearCode, codeSize);
        int prefix = indices[0] & 0xff;
        for (int i = 1; i < indices.length; i++) {
            int k = indices[i] & 0xff;
            int key = (prefix << 8) | k;
            Integer code = table.get(key);
            if (code != null) {
                prefix = code;
                continue;
            }
            writer.writeCode(prefix, codeSize);
            if (nextCode == 0x1000) {
                writer.writeCode(clearCode, codeSize);
                table.clear();
                codeSize = minCodeSize + 1;
                nextCode = eoiCode + 1;
            } else {
                if (nextCode >= (1 << codeSize)) {
                    codeSize++;
                }
                table.put(key, nextCode++);
            }
            prefix = k;
        }
        writer.writeCode(prefix, codeSize);
        writer.writeCode(eoiCode, codeSize);
        writer.finish();
    }

    /**
     * Packs LZW codes LSB-first into bytes and the bytes into the 255-byte
     * data sub-blocks GIF image data is carried in.
     */
    private static final class SubBlockBitWriter {
        private final OutputStream out;
        private final byte[] block = new byte[255];
        private int blockLength;
        private int bitBuffer;
        private int bitCount;

        SubBlockBitWriter(OutputStream out) {
            this.out = out;
        }

        void writeCode(int code, int codeSize) throws IOException {
            bitBuffer |= code << bitCount;
            bitCount += codeSize;
            while (bitCount >= 8) {
                writeByte(bitBuffer & 0xff);
                bitBuffer >>>= 8;
                bitCount -= 8;
            }
        }

        void finish() throws IOException {
            if (bitCount > 0) {
                writeByte(bitBuffer & 0xff);
                bitBuffer = 0;
                bitCount = 0;
            }
            flushBlock();
            out.write(0); // block terminator
        }

        private void writeByte(int b) throws IOException {
            block[blockLength++] = (byte) b;
            if (blockLength == 255) {
                flushBlock();
            }
        }

        private void flushBlock() throws IOException {
            if (blockLength == 0) return;
            out.write(blockLength);
            out.write(block, 0, blockLength);
            blockLength = 0;
        }
    }

    private static void writeShortLE(OutputStream out, int value) throws IOException {
        out.write(value & 0xff);
        out.write((value >>> 8) & 0xff);
    }
}
