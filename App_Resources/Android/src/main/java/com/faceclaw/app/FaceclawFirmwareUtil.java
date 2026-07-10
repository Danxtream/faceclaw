package com.faceclaw.app;

import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.channels.FileChannel;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

/**
 * Native helpers for the on-device custom-firmware build: SHA-256 hashing and
 * binary file writing. Both take a java.nio.ByteBuffer so NativeScript can
 * marshal a JS ArrayBuffer straight across without a per-element copy of the
 * ~4 MB firmware image (and with no overload ambiguity).
 */
public final class FaceclawFirmwareUtil {
    private FaceclawFirmwareUtil() {}

    /** Lowercase hex SHA-256 of the buffer's remaining bytes. */
    public static String sha256Hex(ByteBuffer data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            md.update(data.duplicate());
            byte[] digest = md.digest();
            StringBuilder sb = new StringBuilder(digest.length * 2);
            for (byte b : digest) {
                int v = b & 0xff;
                sb.append(Character.forDigit(v >>> 4, 16));
                sb.append(Character.forDigit(v & 0x0f, 16));
            }
            return sb.toString();
        } catch (NoSuchAlgorithmException e) {
            throw new RuntimeException("SHA-256 unavailable", e);
        }
    }

    /** Write the buffer's remaining bytes to `path`, overwriting any existing file. */
    public static void writeFile(String path, ByteBuffer data) {
        try (FileOutputStream fos = new FileOutputStream(path);
             FileChannel channel = fos.getChannel()) {
            ByteBuffer view = data.duplicate();
            while (view.hasRemaining()) {
                channel.write(view);
            }
        } catch (IOException e) {
            throw new RuntimeException("firmware write failed: " + e.getMessage(), e);
        }
    }
}
