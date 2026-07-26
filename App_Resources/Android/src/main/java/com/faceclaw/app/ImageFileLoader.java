package com.faceclaw.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.util.Log;

/**
 * Decodes image files (and bitmaps generally) to the grayscale packet format
 * used across the TS bridge: [widthLo, widthHi, heightLo, heightHi,
 * pixels...] with one byte per pixel, row-major, or an empty array on
 * failure. FaceclawMediaController's album art shares bitmapToGrayPacket.
 */
public final class ImageFileLoader {
    private static final String TAG = "ImageFileLoader";

    private ImageFileLoader() {}

    /**
     * Decode an image file and downscale it to fit within maxWidth x
     * maxHeight, preserving aspect ratio and never upscaling.
     */
    public static byte[] loadGray(String path, int maxWidth, int maxHeight) {
        if (path == null || maxWidth <= 0 || maxHeight <= 0) {
            return new byte[0];
        }
        try {
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(path, bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
                return new byte[0];
            }
            // Power-of-two subsampling during decode keeps large photos from
            // allocating full-size ARGB buffers; exact fitting happens in
            // bitmapToGrayPacket.
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inSampleSize = 1;
            while (bounds.outWidth / (opts.inSampleSize * 2) >= maxWidth
                    && bounds.outHeight / (opts.inSampleSize * 2) >= maxHeight) {
                opts.inSampleSize *= 2;
            }
            Bitmap bitmap = BitmapFactory.decodeFile(path, opts);
            if (bitmap == null) {
                return new byte[0];
            }
            return bitmapToGrayPacket(bitmap, maxWidth, maxHeight);
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "image decode failed: " + path, e);
            return new byte[0];
        }
    }

    /**
     * Scale a bitmap to fit within maxWidth x maxHeight (preserving aspect,
     * never upscaling) and convert it to the grayscale packet format.
     * Transparent pixels darken toward black (the on-glasses background).
     */
    public static byte[] bitmapToGrayPacket(Bitmap source, int maxWidth, int maxHeight) {
        if (source == null || source.getWidth() <= 0 || source.getHeight() <= 0
                || maxWidth <= 0 || maxHeight <= 0) {
            return new byte[0];
        }
        try {
            float scale = Math.min(1f, Math.min(
                    (float) maxWidth / source.getWidth(),
                    (float) maxHeight / source.getHeight()));
            int width = Math.max(1, Math.round(source.getWidth() * scale));
            int height = Math.max(1, Math.round(source.getHeight() * scale));
            Bitmap scaled = Bitmap.createScaledBitmap(source, width, height, true);
            if (scaled.getConfig() == Bitmap.Config.HARDWARE) {
                scaled = scaled.copy(Bitmap.Config.ARGB_8888, false);
            }
            int[] pixels = new int[width * height];
            scaled.getPixels(pixels, 0, width, 0, 0, width, height);
            byte[] out = new byte[4 + width * height];
            out[0] = (byte) (width & 0xff);
            out[1] = (byte) ((width >> 8) & 0xff);
            out[2] = (byte) (height & 0xff);
            out[3] = (byte) ((height >> 8) & 0xff);
            for (int i = 0; i < pixels.length; i++) {
                int p = pixels[i];
                int a = (p >>> 24) & 0xff;
                int r = (p >> 16) & 0xff;
                int g = (p >> 8) & 0xff;
                int b = p & 0xff;
                out[4 + i] = (byte) (((r * 299 + g * 587 + b * 114) / 1000) * a / 255);
            }
            return out;
        } catch (Exception | OutOfMemoryError e) {
            Log.w(TAG, "bitmap conversion failed", e);
            return new byte[0];
        }
    }
}
