package com.faceclaw.app;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.zip.Deflater;
import android.util.Log;

public final class BleImageOptimizer {
    private BleImageOptimizer() {}
    private static final String TAG = "BleImageOptimizer";

    /**
     * Split an image into fragments (packets), taking advantage of the fact that each packet can declare
     * a logical size longer than its byte payload to get free trailing zero-padding.
     *
     * Each fragment's logical size stays within maxFragmentSize, while trailing zeros inside that span can
     * be omitted from the payload.
     */
    public static List<BleProtocol.ImageFragment> planImageFragments(byte[] bmp, int maxFragmentSize) {
        return planImageFragments(bmp, maxFragmentSize, false);
    }

    public static List<BleProtocol.ImageFragment> planImageFragments(
        byte[] bmp,
        int maxFragmentSize,
        boolean reserveFinalByte
    ) {
        if (bmp == null || bmp.length == 0) {
            return Collections.singletonList(new BleProtocol.ImageFragment(0, new byte[0], 0));
        }
        if (maxFragmentSize <= 0) {
            throw new IllegalArgumentException("maxFragmentSize must be positive");
        }

        final int bulkLength = reserveFinalByte ? bmp.length - 1 : bmp.length;
        final int fragmentCount = ((bulkLength + maxFragmentSize - 1) / maxFragmentSize)
                + (bulkLength < bmp.length ? 1 : 0);
        final List<BleProtocol.ImageFragment> fragments = new ArrayList<>(fragmentCount);
        for (int index = 0; index * maxFragmentSize < bulkLength; index++) {
            int start = index * maxFragmentSize;
            int end = Math.min(start + maxFragmentSize, bulkLength);
            fragments.add(buildFragment(index, bmp, start, end));
        }
        if (bulkLength < bmp.length) {
            fragments.add(new BleProtocol.ImageFragment(
                fragments.size(),
                Arrays.copyOfRange(bmp, bulkLength, bmp.length),
                bmp.length - bulkLength
            ));
        }
        Log.i(TAG, "planImageFragments: fragments=" + fragments.size() + ", bmp.length=" + bmp.length + ", maxFragmentSize=" + maxFragmentSize);
        return fragments;
    }

    private static BleProtocol.ImageFragment buildFragment(int index, byte[] bmp, int start, int end) {
        int dataEnd = end;
        while (dataEnd > start && bmp[dataEnd - 1] == 0) {
            dataEnd -= 1;
        }
        if (dataEnd == start) {
            return new BleProtocol.ImageFragment(index, new byte[0], end - start);
        }
        return new BleProtocol.ImageFragment(
            index,
            Arrays.copyOfRange(bmp, start, dataEnd),
            end - start
        );
    }

    public static final class TileImagePlan {
        final int tileIndex;
        final BleProtocol.ImageTileOptions tile;
        final byte[] bmp;      // raw 4bpp BMP, kept for the displayed-tile dedup cache
        final byte[] payload;  // bytes actually streamed: mode-6 zlib 4bpp when it shrinks, else == bmp
        final int sessionId;
        List<BleProtocol.ImageFragment> fragments = Collections.emptyList();

        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] bmp, int sessionId) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.bmp = BmpUtil.copyTileBmp(bmp);
            this.payload = maybeCompress(this.bmp);
            this.sessionId = sessionId;
        }
    }

    /**
     * zlib-deflate headerless 4bpp pixels for CFW load_image_z mode 6 when it
     * shrinks the payload. Wire format: [6][zlib stream]. A raw BMP (starts 'B')
     * is sent verbatim when compression does not help.
     */
    static byte[] maybeCompress(byte[] bmp) {
        if (bmp == null || bmp.length == 0) {
            return bmp;
        }
        byte[] packed = BmpUtil.pack4bppFromBmp(bmp);
        if (packed.length == 0) {
            return bmp;
        }
        byte[] z = deflate(packed);
        if (z == null || z.length + 1 >= packed.length) {
            return bmp;
        }
        byte[] out = new byte[z.length + 1];
        out[0] = 6;
        System.arraycopy(z, 0, out, 1, z.length);
        return out;
    }

    private static byte[] deflate(byte[] data) {
        // Level 6: BEST_COMPRESSION cost 18-109ms per frame on the BLE worker,
        // but BEST_SPEED inflated typical payloads from ~2.7KB past the 3800-byte
        // fragment boundary, adding a whole extra ack round trip (~350ms). The
        // default level keeps payloads under one fragment at about half the CPU.
        Deflater deflater = new Deflater(Deflater.DEFAULT_COMPRESSION);
        deflater.setInput(data);
        deflater.finish();
        ByteArrayOutputStream out = new ByteArrayOutputStream(Math.max(64, data.length / 3));
        byte[] buf = new byte[4096];
        try {
            while (!deflater.finished()) {
                out.write(buf, 0, deflater.deflate(buf));
            }
        } finally {
            deflater.end();
        }
        return out.toByteArray();
    }

    public static final class ImageUpdateStats {
        final int paintMs;
        final int tileCount;
        final int frameId;
        long firstWriteStartedAtMs;

        ImageUpdateStats(int paintMs, int tileCount, int frameId) {
            this.paintMs = Math.max(0, paintMs);
            this.tileCount = tileCount;
            this.frameId = frameId;
        }
    }
}
