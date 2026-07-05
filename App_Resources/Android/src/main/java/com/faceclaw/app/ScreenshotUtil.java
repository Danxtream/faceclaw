package com.faceclaw.app;

import android.content.Context;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.ByteBuffer;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * Saves raw screenshots for compression experiments. The output is the exact
 * headerless top-down 4bpp frame buffer that gets zlib-compressed on the wire
 * (build4bppBmp followed by pack4bppFromBmp), deliberately untransformed — no
 * resize, no gamma, no header.
 */
public final class ScreenshotUtil {
    private ScreenshotUtil() {}

    /** Returns the absolute path of the written file. */
    public static String saveRawScreenshot(Context context, ByteBuffer image8bpp, int width, int height) throws java.io.IOException {
        if (image8bpp == null || width <= 0 || height <= 0 || image8bpp.remaining() < width * height) {
            throw new IllegalArgumentException("invalid screenshot buffer");
        }
        byte[] gray = new byte[image8bpp.remaining()];
        image8bpp.get(gray);
        byte[] packed = BmpUtil.pack4bppFromBmp(BmpUtil.build4bppBmp(gray, width, height));
        if (packed.length == 0) {
            throw new IllegalStateException("failed to pack 4bpp frame");
        }

        File dir = new File(context.getExternalFilesDir(null), "screenshots");
        if (!dir.exists() && !dir.mkdirs()) {
            throw new java.io.IOException("failed to create " + dir);
        }
        String stamp = new SimpleDateFormat("yyyyMMdd-HHmmss-SSS", Locale.US).format(new Date());
        File file = new File(dir, "screen-" + stamp + "-" + width + "x" + height + ".4bpp");
        try (FileOutputStream out = new FileOutputStream(file)) {
            out.write(packed);
        }
        return file.getAbsolutePath();
    }
}
