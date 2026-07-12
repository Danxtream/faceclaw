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

        /**
         * Plan with an explicit wire payload (e.g. a mode-3 incremental update).
         * bmp must still be the FULL new frame: it feeds the displayed-frame
         * dedup cache, which after an applied incremental equals the full frame.
         */
        TileImagePlan(int tileIndex, BleProtocol.ImageTileOptions tile, byte[] bmp, int sessionId, byte[] payloadOverride) {
            this.tileIndex = tileIndex;
            this.tile = tile;
            this.bmp = BmpUtil.copyTileBmp(bmp);
            this.payload = payloadOverride;
            this.sessionId = sessionId;
        }
    }

    /**
     * Build a mode-3 bounding-box incremental payload, or null when a full
     * update should be sent instead (frames not comparable, or the changed
     * region spans the whole screen). Wire format:
     *   [3][left/4][top/2][width/4][height/2][fid_lo][fid_hi][zlib of headerless 4bpp region]
     * The region is top-down rows of the NEW frame, stride width/2 bytes. The
     * box is aligned so left/width are multiples of 4 pixels and top/height
     * multiples of 2 rows, letting each coordinate fit one byte and avoiding
     * 4bpp byte-boundary corner cases. Identical frames yield null too; the
     * caller's dedup check should normally catch that first.
     *
     * frameId is a little-endian uint16 the CFW uses to detect reordered,
     * skipped or duplicated deltas (its diagnostic overlay); the caller advances
     * it by 1 per emitted delta so consecutive deltas are consecutive.
     */
    /**
     * A mode-3 incremental payload plus diagnostics about how tightly the
     * bounding box fit the actual change. {@code changedBytes} is how many
     * packed bytes actually differ; {@code boxBytes} is how many the box sends.
     * A large box with few changed bytes / multiple clusters means distant
     * small edits were merged into one oversized box (which can spill past the
     * fragment size into an extra serialized BLE message).
     */
    public static final class IncrementalPlan {
        public final byte[] payload;
        public final int changedBytes;
        public final int boxBytes;
        public final int clusterCount;

        IncrementalPlan(byte[] payload, int changedBytes, int boxBytes, int clusterCount) {
            this.payload = payload;
            this.changedBytes = changedBytes;
            this.boxBytes = boxBytes;
            this.clusterCount = clusterCount;
        }
    }

    public static IncrementalPlan buildIncrementalImagePayload(byte[] previousBmp, byte[] newBmp, int frameId) {
        int width = BmpUtil.readBmpWidth(newBmp);
        int height = BmpUtil.readBmpHeight(newBmp);
        if (width <= 0 || height <= 0
                || width != BmpUtil.readBmpWidth(previousBmp)
                || height != BmpUtil.readBmpHeight(previousBmp)) {
            return null;
        }
        byte[] previous = BmpUtil.pack4bppFromBmp(previousBmp);
        byte[] next = BmpUtil.pack4bppFromBmp(newBmp);
        int stride = (width + 1) >> 1;
        if (previous.length != stride * height || next.length != stride * height) {
            return null;
        }

        // Full diff scan in packed-byte coordinates (1 byte = 2 pixels): the
        // changed bounding box plus diagnostics (total changed bytes, and how
        // many disjoint horizontal column-clusters the change splits into).
        int minByteX = stride;
        int maxByteX = -1;
        int minY = height;
        int maxY = -1;
        int changedBytes = 0;
        boolean[] columnChanged = new boolean[stride];
        for (int y = 0; y < height; y++) {
            int rowOffset = y * stride;
            for (int x = 0; x < stride; x++) {
                if (previous[rowOffset + x] != next[rowOffset + x]) {
                    changedBytes++;
                    columnChanged[x] = true;
                    if (x < minByteX) minByteX = x;
                    if (x > maxByteX) maxByteX = x;
                    if (y < minY) minY = y;
                    maxY = y;
                }
            }
        }
        if (maxY < 0) {
            return null; // identical
        }
        int clusterCount = 0;
        boolean inCluster = false;
        for (int x = minByteX; x <= maxByteX; x++) {
            if (columnChanged[x]) {
                if (!inCluster) clusterCount++;
                inCluster = true;
            } else {
                inCluster = false;
            }
        }

        // Pixel-space box, aligned: left/width to multiples of 4, top/height to
        // multiples of 2, clamped to the frame.
        int left = (minByteX * 2) & ~3;
        int rightExclusive = Math.min(width, (((maxByteX + 1) * 2) + 3) & ~3);
        int top = minY & ~1;
        int bottomExclusive = Math.min(height, (maxY + 2) & ~1);
        int boxWidth = rightExclusive - left;
        int boxHeight = bottomExclusive - top;
        if (boxWidth >= width && boxHeight >= height) {
            return null; // whole screen changed; full update is strictly better
        }

        int regionStride = boxWidth >> 1;
        byte[] region = new byte[regionStride * boxHeight];
        for (int y = 0; y < boxHeight; y++) {
            System.arraycopy(next, (top + y) * stride + (left >> 1), region, y * regionStride, regionStride);
        }
        byte[] compressed = deflate(region);
        byte[] out = new byte[7 + compressed.length];
        out[0] = 3;
        out[1] = (byte) (left / 4);
        out[2] = (byte) (top / 2);
        out[3] = (byte) (boxWidth / 4);
        out[4] = (byte) (boxHeight / 2);
        out[5] = (byte) (frameId & 0xff);          // fid_lo
        out[6] = (byte) ((frameId >> 8) & 0xff);   // fid_hi
        System.arraycopy(compressed, 0, out, 7, compressed.length);
        return new IncrementalPlan(out, changedBytes, region.length, clusterCount);
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
