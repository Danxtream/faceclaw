package com.faceclaw.app;
import java.util.Arrays;

public class BmpUtil {
    public static byte[] copyTileBmp(byte[] bmp) {
        if (bmp == null || bmp.length == 0) {
            return new byte[0];
        }
        return Arrays.copyOf(bmp, bmp.length);
    }

    public static byte[] buildBlankWarmupBmp(byte[] bmp) {
        byte[] warmup = BmpUtil.copyTileBmp(bmp);
        int pixelOffset = readBmpPixelOffset(warmup);
        if (pixelOffset <= 0 || pixelOffset >= warmup.length) {
            Arrays.fill(warmup, (byte) 0);
            return warmup;
        }
        Arrays.fill(warmup, pixelOffset, warmup.length, (byte) 0);
        return warmup;
    }

    /**
     * Build a 4bpp grayscale BMP (BITMAPINFOHEADER + 16-entry gray palette,
     * bottom-up rows padded to a 4-byte stride) from a full-resolution 8bpp
     * grayscale buffer. The buffer is row-major, top-to-bottom, one byte per
     * pixel with values 0..255; each pixel is quantized to a 4-bit nibble.
     *
     * Building the wire format here, rather than on the TypeScript side, keeps
     * all framing concerns in one place so future firmware changes that drop or
     * replace the BMP header (e.g. 8-bit color depth or iframes) only touch Java.
     */
    public static byte[] build4bppBmp(byte[] gray8, int width, int height) {
        if (width <= 0 || height <= 0) {
            return new byte[0];
        }
        int bytesPerPixelRow = (width + 1) >> 1;
        int rowStride = (bytesPerPixelRow + 3) & ~3;
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
            int srcRowOffset = srcY * width;
            int rowOffset = pixelOffset + bmpRow * rowStride;
            for (int x = 0; x < width; x += 2) {
                int hi = grayToNibble(sampleGray(gray8, srcRowOffset + x));
                int lo = (x + 1 < width) ? grayToNibble(sampleGray(gray8, srcRowOffset + x + 1)) : 0;
                buf[rowOffset + (x >> 1)] = (byte) ((hi << 4) | lo);
            }
        }
        return buf;
    }

    private static int sampleGray(byte[] gray8, int index) {
        return (index >= 0 && index < gray8.length) ? (gray8[index] & 0xff) : 0;
    }

    private static int grayToNibble(int value) {
        if (value <= 0) {
            return 0;
        }
        return Math.min(15, (value + 15) >> 4);
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

    public static int readBmpPixelOffset(byte[] bmp) {
        if (bmp == null || bmp.length < 14 || bmp[0] != 0x42 || bmp[1] != 0x4d) {
            return -1;
        }
        return (bmp[10] & 0xff)
              | ((bmp[11] & 0xff) << 8)
              | ((bmp[12] & 0xff) << 16)
              | ((bmp[13] & 0xff) << 24);
    }
}
