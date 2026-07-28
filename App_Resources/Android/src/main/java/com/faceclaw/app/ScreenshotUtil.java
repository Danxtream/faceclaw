package com.faceclaw.app;

import android.content.Context;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.zip.CRC32;
import java.util.zip.Deflater;

/**
 * Saves screenshots of the composited screen as 4-bit grayscale PNGs (the
 * display's native depth). Retrieve with
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/screenshots/
 */
public final class ScreenshotUtil {
    private ScreenshotUtil() {}

    /** Returns the absolute path of the written file. */
    public static String savePngScreenshot(Context context, byte[] gray, int width, int height) throws IOException {
        if (gray == null || width <= 0 || height <= 0 || gray.length < width * height) {
            throw new IllegalArgumentException("invalid screenshot buffer");
        }
        byte[] png = encode4BitGrayPng(gray, width, height);
        File file = new File(ensureScreenshotsDir(context), "screen-" + timestamp() + ".png");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(png);
        }
        return file.getAbsolutePath();
    }

    static File ensureScreenshotsDir(Context context) throws IOException {
        File dir = new File(context.getExternalFilesDir(null), "screenshots");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new IOException("failed to create " + dir);
        }
        return dir;
    }

    static String timestamp() {
        return new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(new Date());
    }

    /**
     * Encode an 8bpp grayscale buffer as a bit-depth-4 grayscale PNG, keeping
     * the top nibble of each pixel (the same quantization the wire format uses).
     */
    static byte[] encode4BitGrayPng(byte[] gray, int width, int height) {
        // Raw scanlines: one filter byte (0 = None) then two pixels per byte,
        // leftmost pixel in the high nibble.
        int rowBytes = (width + 1) / 2;
        byte[] raw = new byte[height * (1 + rowBytes)];
        int p = 0;
        for (int y = 0; y < height; y++) {
            raw[p++] = 0;
            int row = y * width;
            for (int x = 0; x < width; x += 2) {
                int hi = (gray[row + x] & 0xff) >>> 4;
                int lo = (x + 1 < width) ? (gray[row + x + 1] & 0xff) >>> 4 : 0;
                raw[p++] = (byte) ((hi << 4) | lo);
            }
        }

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        out.write(0x89);
        out.write('P');
        out.write('N');
        out.write('G');
        out.write(0x0d);
        out.write(0x0a);
        out.write(0x1a);
        out.write(0x0a);

        ByteArrayOutputStream ihdr = new ByteArrayOutputStream();
        writeIntBE(ihdr, width);
        writeIntBE(ihdr, height);
        ihdr.write(4); // bit depth
        ihdr.write(0); // color type: grayscale
        ihdr.write(0); // compression
        ihdr.write(0); // filter
        ihdr.write(0); // interlace
        writeChunk(out, "IHDR", ihdr.toByteArray());
        writeChunk(out, "IDAT", zlibDeflate(raw));
        writeChunk(out, "IEND", new byte[0]);
        return out.toByteArray();
    }

    static byte[] zlibDeflate(byte[] data) {
        Deflater deflater = new Deflater();
        deflater.setInput(data);
        deflater.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length / 8));
        byte[] buffer = new byte[8192];
        while (!deflater.finished()) {
            out.write(buffer, 0, deflater.deflate(buffer));
        }
        deflater.end();
        return out.toByteArray();
    }

    private static void writeChunk(ByteArrayOutputStream out, String type, byte[] data) {
        writeIntBE(out, data.length);
        CRC32 crc = new CRC32();
        for (int i = 0; i < 4; i++) {
            int b = type.charAt(i);
            out.write(b);
            crc.update(b);
        }
        out.write(data, 0, data.length);
        crc.update(data);
        writeIntBE(out, (int) crc.getValue());
    }

    private static void writeIntBE(ByteArrayOutputStream out, int value) {
        out.write((value >>> 24) & 0xff);
        out.write((value >>> 16) & 0xff);
        out.write((value >>> 8) & 0xff);
        out.write(value & 0xff);
    }
}
