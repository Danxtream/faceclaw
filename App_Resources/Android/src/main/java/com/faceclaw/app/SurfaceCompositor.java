package com.faceclaw.app;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Retained-surface compositor: the phone-side model of what is on the glasses
 * screen.
 *
 * Each surface is an 8bpp grayscale buffer retained at its last-submitted
 * contents, positioned on the screen with a z-order and a transparency mode.
 * Sources on the TS side (today the dashboard; later the shell and per-app
 * worker threads) submit updates to their surface, and the compositor
 * recombines the retained surfaces into a full-screen frame that feeds the
 * existing dedupe/compress/transmit pipeline. Because every surface is
 * retained, a full screen frame can be regenerated at any time (frame drops,
 * reconnects, previews, screenshots) without asking sources to repaint.
 *
 * Surface format contract (mirrored by the TS side):
 * - Pixels are 8bpp grayscale, row-major, one byte per pixel. The wire
 *   pipeline quantizes to 4bpp downstream, so the low nibble is not visible.
 * - TRANSPARENCY_COLOR_KEY surfaces treat pixel value 0 as fully transparent
 *   and value 1 as black. Quantization collapses 1 into the same 4bpp level
 *   as 0, so reserving 0 costs no visible shade; painters of color-key
 *   surfaces must clamp intentional black to 1.
 * - An update may cover any rect of its surface; the rest is retained. The
 *   update buffer holds exactly rectWidth*rectHeight bytes, row-major.
 * - Surfaces composite in ascending z-order onto a black (0) background.
 * - Surface geometry changes take effect when the next frame composites;
 *   they do not trigger a recomposite by themselves.
 *
 * Thread safety: all methods are safe to call from any thread. Apply and
 * composite happen atomically under an internal lock, and each composite
 * carries a monotonic sequence number so callers can detect when a composite
 * was superseded by a concurrent one before being acted on.
 */
public final class SurfaceCompositor {
    public static final int TRANSPARENCY_OPAQUE = 0;
    public static final int TRANSPARENCY_COLOR_KEY = 1;

    /** One composited full-screen frame plus the metadata the pipeline needs. */
    public static final class Composite {
        /** Full-screen 8bpp grayscale pixels, screenWidth*screenHeight bytes. */
        public final byte[] gray;
        public final int width;
        public final int height;
        /**
         * Stable identifier of screen content, combining every surface's
         * geometry and content fingerprint; equal fingerprints mean equal
         * composited pixels.
         */
        public final String fingerprint;
        /** Monotonic: a Composite with a higher seq contains strictly newer state. */
        public final long seq;

        Composite(byte[] gray, int width, int height, String fingerprint, long seq) {
            this.gray = gray;
            this.width = width;
            this.height = height;
            this.fingerprint = fingerprint;
            this.seq = seq;
        }
    }

    private static final class Surface {
        final String id;
        int x;
        int y;
        int width;
        int height;
        int zOrder;
        int transparency;
        boolean visible = true;
        byte[] pixels;
        String fingerprint = "";

        Surface(String id) {
            this.id = id;
        }
    }

    private final Object lock = new Object();
    private int screenWidth;
    private int screenHeight;
    private boolean blanked;
    private final Map<String, Surface> surfaces = new HashMap<>();
    private long nextCompositeSeq = 1;

    /** Set the output frame size. Must be called before any surface work. */
    public void configureScreen(int width, int height) {
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("bad screen size " + width + "x" + height);
        }
        synchronized (lock) {
            this.screenWidth = width;
            this.screenHeight = height;
        }
    }

    /**
     * Create a surface or update an existing one's geometry. A resize discards
     * the surface's retained pixels (reset to 0).
     */
    public void configureSurface(String id, int x, int y, int width, int height, int zOrder, int transparency) {
        if (id == null || id.isEmpty()) {
            throw new IllegalArgumentException("surface id must be non-empty");
        }
        if (width <= 0 || height <= 0) {
            throw new IllegalArgumentException("bad surface size " + width + "x" + height + " for " + id);
        }
        if (transparency != TRANSPARENCY_OPAQUE && transparency != TRANSPARENCY_COLOR_KEY) {
            throw new IllegalArgumentException("bad transparency mode " + transparency + " for " + id);
        }
        synchronized (lock) {
            requireScreenConfiguredLocked();
            Surface surface = surfaces.get(id);
            if (surface == null) {
                surface = new Surface(id);
                surfaces.put(id, surface);
            }
            if (surface.pixels == null || surface.width != width || surface.height != height) {
                surface.pixels = new byte[width * height];
                surface.fingerprint = "";
            }
            surface.x = x;
            surface.y = y;
            surface.width = width;
            surface.height = height;
            surface.zOrder = zOrder;
            surface.transparency = transparency;
        }
    }

    public void removeSurface(String id) {
        synchronized (lock) {
            surfaces.remove(id);
        }
    }

    /**
     * Hidden surfaces keep their retained pixels and accept updates, but are
     * excluded from the composite and its fingerprint (used for background
     * windows). Takes effect when the next frame composites.
     */
    public void setSurfaceVisible(String id, boolean visible) {
        synchronized (lock) {
            Surface surface = surfaces.get(id);
            if (surface == null) {
                throw new IllegalArgumentException("unknown surface " + id);
            }
            surface.visible = visible;
        }
    }

    /**
     * While blanked (screen off), composites are all-zero regardless of
     * surface content; retained state is untouched, so unblanking restores
     * the screen without asking sources to repaint.
     */
    public void setBlanked(boolean blanked) {
        synchronized (lock) {
            this.blanked = blanked;
        }
    }

    /**
     * Apply an update to one surface and composite the whole screen, as one
     * atomic step. The update covers the rect (rectX, rectY, rectWidth,
     * rectHeight) in surface-local coordinates; pixels must hold exactly
     * rectWidth*rectHeight bytes. contentFingerprint identifies the surface's
     * full content after this update.
     */
    public Composite applyAndComposite(
            String surfaceId,
            ByteBuffer pixels,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint
    ) {
        synchronized (lock) {
            requireScreenConfiguredLocked();
            Surface surface = surfaces.get(surfaceId);
            if (surface == null) {
                throw new IllegalArgumentException("unknown surface " + surfaceId);
            }
            if (rectX < 0 || rectY < 0 || rectWidth <= 0 || rectHeight <= 0
                    || rectX + rectWidth > surface.width || rectY + rectHeight > surface.height) {
                throw new IllegalArgumentException("update rect " + rectWidth + "x" + rectHeight
                        + "+" + rectX + "+" + rectY + " outside surface " + surfaceId
                        + " (" + surface.width + "x" + surface.height + ")");
            }
            int expectedBytes = rectWidth * rectHeight;
            if (pixels == null || pixels.remaining() != expectedBytes) {
                throw new IllegalArgumentException("update buffer for " + surfaceId + " has "
                        + (pixels == null ? 0 : pixels.remaining()) + " bytes, expected " + expectedBytes);
            }
            for (int row = 0; row < rectHeight; row++) {
                int dstOffset = (rectY + row) * surface.width + rectX;
                pixels.get(surface.pixels, dstOffset, rectWidth);
            }
            surface.fingerprint = contentFingerprint == null ? "" : contentFingerprint;
            return compositeLocked();
        }
    }

    /** Composite the current retained state without applying an update. */
    public Composite composite() {
        synchronized (lock) {
            requireScreenConfiguredLocked();
            return compositeLocked();
        }
    }

    private Composite compositeLocked() {
        byte[] gray = new byte[screenWidth * screenHeight];
        if (blanked) {
            return new Composite(gray, screenWidth, screenHeight,
                    "blanked:" + screenWidth + "x" + screenHeight, nextCompositeSeq++);
        }
        List<Surface> ordered = new ArrayList<>(surfaces.values());
        ordered.sort(Comparator
                .comparingInt((Surface s) -> s.zOrder)
                .thenComparing(s -> s.id));
        StringBuilder fingerprint = new StringBuilder();
        fingerprint.append(screenWidth).append('x').append(screenHeight);
        for (Surface surface : ordered) {
            if (!surface.visible) continue;
            blendLocked(gray, surface);
            fingerprint.append('|').append(surface.id)
                    .append('@').append(surface.x).append(',').append(surface.y)
                    .append('+').append(surface.width).append('x').append(surface.height)
                    .append('#').append(surface.zOrder)
                    .append(':').append(surface.transparency)
                    .append(':').append(surface.fingerprint);
        }
        return new Composite(gray, screenWidth, screenHeight, fingerprint.toString(), nextCompositeSeq++);
    }

    private void blendLocked(byte[] gray, Surface surface) {
        // Clip the surface rect to the screen.
        int srcX = Math.max(0, -surface.x);
        int srcY = Math.max(0, -surface.y);
        int dstX = Math.max(0, surface.x);
        int dstY = Math.max(0, surface.y);
        int copyWidth = Math.min(surface.width - srcX, screenWidth - dstX);
        int copyHeight = Math.min(surface.height - srcY, screenHeight - dstY);
        if (copyWidth <= 0 || copyHeight <= 0) {
            return;
        }
        for (int row = 0; row < copyHeight; row++) {
            int srcOffset = (srcY + row) * surface.width + srcX;
            int dstOffset = (dstY + row) * screenWidth + dstX;
            if (surface.transparency == TRANSPARENCY_OPAQUE) {
                System.arraycopy(surface.pixels, srcOffset, gray, dstOffset, copyWidth);
            } else {
                for (int col = 0; col < copyWidth; col++) {
                    byte value = surface.pixels[srcOffset + col];
                    if (value != 0) {
                        gray[dstOffset + col] = value;
                    }
                }
            }
        }
    }

    private void requireScreenConfiguredLocked() {
        if (screenWidth <= 0 || screenHeight <= 0) {
            throw new IllegalStateException("configureScreen must be called first");
        }
    }
}
