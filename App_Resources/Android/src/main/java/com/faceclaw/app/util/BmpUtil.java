package com.faceclaw.app;
import java.util.Arrays;

public class BmpUtil {
    public static byte[] copyTileBmp(byte[] bmp) {
        if (bmp == null || bmp.length == 0) {
            return new byte[0];
        }
        return Arrays.copyOf(bmp, bmp.length);
    }

    // Quantize an 8-bit gray value to a 4-bit nibble. Truncate rather than round
    // up at the bottom: the shell's color-key convention paints intentional
    // black as 1 (0 being transparent), which must land on nibble 0, not a
    // faintly-visible level 1.
    private static final byte[] GRAY_TO_NIBBLE = new byte[256];
    static {
        for (int v = 1; v < 256; v++) {
            GRAY_TO_NIBBLE[v] = (byte) Math.min(15, (v + 8) >> 4);
        }
    }

    /**
     * Pack a full-resolution 8bpp grayscale buffer (row-major, top-to-bottom,
     * one byte per pixel) into the headerless 4bpp wire format used by CFW
     * load_image_z modes 3/6/8: top-down rows, stride ceil(width/2), high
     * nibble = left pixel. This is the canonical in-memory frame format; BMP
     * framing (needed only when an uncompressed full frame goes on the wire)
     * is added on demand by build4bppBmpFromPacked.
     */
    public static byte[] pack4bppFromGray8(byte[] gray8, int width, int height) {
        if (width <= 0 || height <= 0) {
            return new byte[0];
        }
        int stride = (width + 1) >> 1;
        byte[] out = new byte[stride * height];
        if (gray8 == null || gray8.length < width * height) {
            return out; // short buffer: treat missing pixels as black
        }
        int pairs = width >> 1;
        int src = 0;
        int dst = 0;
        for (int y = 0; y < height; y++) {
            for (int i = 0; i < pairs; i++) {
                out[dst++] = (byte) ((GRAY_TO_NIBBLE[gray8[src] & 0xff] << 4)
                        | GRAY_TO_NIBBLE[gray8[src + 1] & 0xff]);
                src += 2;
            }
            if ((width & 1) != 0) {
                out[dst++] = (byte) (GRAY_TO_NIBBLE[gray8[src++] & 0xff] << 4);
            }
        }
        return out;
    }

    /**
     * Wrap a packed 4bpp frame in BMP framing (BITMAPINFOHEADER + 16-entry gray
     * palette, bottom-up rows padded to a 4-byte stride). Only the full-frame
     * image path still speaks BMP on the wire (warmup, and the fallback when
     * mode-6 compression does not shrink the frame); everything else uses the
     * headerless packed format directly.
     */
    public static byte[] build4bppBmpFromPacked(byte[] packed, int width, int height) {
        int packedStride = (width + 1) >> 1;
        if (width <= 0 || height <= 0
                || packed == null || packed.length < packedStride * height) {
            return new byte[0];
        }
        int rowStride = (packedStride + 3) & ~3;
        int pixelDataSize = rowStride * height;

        int fileHeaderSize = 14;
        int dibHeaderSize = 40;
        int paletteSize = 16 * 4;
        int pixelOffset = fileHeaderSize + dibHeaderSize + paletteSize;
        int fileSize = pixelOffset + pixelDataSize;

        byte[] buf = new byte[fileSize];
        buf[0] = 0x42; // 'B'
        buf[1] = 0x4d; // 'M'
        putUint32Le(buf, 2, fileSize);
        putUint32Le(buf, 10, pixelOffset);
        putUint32Le(buf, 14, dibHeaderSize);
        putInt32Le(buf, 18, width);
        putInt32Le(buf, 22, height);
        putUint16Le(buf, 26, 1);  // planes
        putUint16Le(buf, 28, 4);  // bits per pixel
        putUint32Le(buf, 30, 0);  // compression (BI_RGB)
        putUint32Le(buf, 34, pixelDataSize);
        putUint32Le(buf, 46, 16); // palette entry count

        for (int i = 0; i < 16; i++) {
            int v = i * 17;
            int base = fileHeaderSize + dibHeaderSize + i * 4;
            buf[base] = (byte) v;
            buf[base + 1] = (byte) v;
            buf[base + 2] = (byte) v;
            buf[base + 3] = 0;
        }

        for (int bmpRow = 0; bmpRow < height; bmpRow++) {
            int srcY = height - 1 - bmpRow; // BMP rows run bottom-up
            System.arraycopy(packed, srcY * packedStride,
                    buf, pixelOffset + bmpRow * rowStride, packedStride);
        }
        return buf;
    }

    private static void putUint16Le(byte[] buf, int offset, int value) {
        buf[offset] = (byte) (value & 0xff);
        buf[offset + 1] = (byte) ((value >>> 8) & 0xff);
    }

    private static void putUint32Le(byte[] buf, int offset, int value) {
        buf[offset] = (byte) (value & 0xff);
        buf[offset + 1] = (byte) ((value >>> 8) & 0xff);
        buf[offset + 2] = (byte) ((value >>> 16) & 0xff);
        buf[offset + 3] = (byte) ((value >>> 24) & 0xff);
    }

    private static void putInt32Le(byte[] buf, int offset, int value) {
        putUint32Le(buf, offset, value);
    }
}
