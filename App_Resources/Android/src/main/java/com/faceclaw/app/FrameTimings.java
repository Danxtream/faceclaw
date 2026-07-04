package com.faceclaw.app;

import android.content.Context;
import android.os.SystemClock;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Per-frame timing instrumentation, shared between the Java BLE layer and the
 * Typescript UI layer. A "frame" starts when we receive an input event (or a
 * timer fires and we decide to redraw), and finishes when the resulting screen
 * update has been fully transmitted to the glasses, is discarded unsent, or
 * times out because nobody reported finishing it.
 *
 * All public methods are thread-safe and cheap enough to call from the BLE
 * worker thread, the Android main thread, and the JS thread. Frame IDs are
 * positive ints; 0 means "no frame" and is silently ignored everywhere, so
 * callers do not need to null-check.
 *
 * Statistics (p50/p90/p99 of event-to-last-ack for sent frames) and full log
 * lines for recent and slowest frames are periodically exported to
 * getExternalFilesDir()/frame-timings.txt, retrievable via
 *   adb pull /sdcard/Android/data/<pkg>/files/frame-timings.txt
 */
public final class FrameTimings {
    private static final String TAG = "FrameTimings";
    private static final FrameTimings INSTANCE = new FrameTimings();

    /** Frames still open after this long are finished as "timeout". */
    private static final long FRAME_TIMEOUT_MS = 30_000;
    private static final long EXPORT_INTERVAL_MS = 15_000;
    private static final long SWEEP_INTERVAL_MS = 5_000;
    private static final int RECENT_FRAMES_KEPT = 50;
    private static final int SLOWEST_FRAMES_KEPT = 20;
    private static final int SENT_DURATIONS_WINDOW = 512;
    private static final int MAX_LINES_PER_FRAME = 200;
    private static final String EXPORT_FILE_NAME = "frame-timings.txt";

    public static FrameTimings getInstance() {
        return INSTANCE;
    }

    private static final class Frame {
        final int id;
        final String reason;
        final long startedAtMs;       // SystemClock.elapsedRealtime()
        final long startedWallClockMs;
        final List<String> lines = new ArrayList<>();
        final Map<String, Long> openSpans = new HashMap<>();
        long finishedAtMs;
        String outcome; // null while open; "sent", "discarded: ...", "timeout: ..."

        Frame(int id, String reason, long startedAtMs, long startedWallClockMs) {
            this.id = id;
            this.reason = reason;
            this.startedAtMs = startedAtMs;
            this.startedWallClockMs = startedWallClockMs;
        }

        long durationMs() {
            return finishedAtMs - startedAtMs;
        }

        boolean wasSent() {
            return outcome != null && outcome.startsWith("sent");
        }
    }

    private final Object lock = new Object();
    private final Map<Integer, Frame> activeFrames = new HashMap<>();
    private final ArrayDeque<Frame> recentFrames = new ArrayDeque<>();
    private final List<Frame> slowestSentFrames = new ArrayList<>();
    private final ArrayDeque<Long> sentDurations = new ArrayDeque<>();
    private int nextFrameId = 1;
    private long framesStarted;
    private long framesSent;
    private long framesDiscarded;
    private long framesTimedOut;
    private boolean exportDirty;
    private File exportDir;
    private Thread exportThread;

    private FrameTimings() {
    }

    /** Idempotent; enables filesystem export. Safe to call from any constructor path. */
    public void init(Context context) {
        File dir = context.getApplicationContext().getExternalFilesDir(null);
        if (dir == null) {
            dir = context.getApplicationContext().getFilesDir();
        }
        synchronized (lock) {
            exportDir = dir;
            if (exportThread == null) {
                exportThread = new Thread(this::exportLoop, "FrameTimingsExport");
                exportThread.setDaemon(true);
                exportThread.start();
            }
        }
    }

    /** Begin a frame; reason is a short label like "input:sys-event:0". Returns the frame ID. */
    public int startFrame(String reason) {
        long now = SystemClock.elapsedRealtime();
        Frame frame;
        synchronized (lock) {
            frame = new Frame(nextFrameId++, reason == null ? "" : reason, now, System.currentTimeMillis());
            activeFrames.put(frame.id, frame);
            framesStarted++;
        }
        return frame.id;
    }

    public void log(int frameId, String message) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = activeFrames.get(frameId);
            if (frame == null) {
                return;
            }
            addLineLocked(frame, now, message);
        }
    }

    public void spanStart(int frameId, String name) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = activeFrames.get(frameId);
            if (frame == null) {
                return;
            }
            frame.openSpans.put(name, now);
            addLineLocked(frame, now, "span " + name + " start");
        }
    }

    public void spanEnd(int frameId, String name) {
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            Frame frame = activeFrames.get(frameId);
            if (frame == null) {
                return;
            }
            Long startedAt = frame.openSpans.remove(name);
            if (startedAt == null) {
                addLineLocked(frame, now, "span " + name + " end (start not recorded)");
            } else {
                addLineLocked(frame, now, "span " + name + " end (" + (now - startedAt) + "ms)");
            }
        }
    }

    /**
     * Finish a frame. Outcomes: "sent" (counted in latency percentiles), anything
     * starting with "discarded", or "timeout". First finish wins; later calls for
     * the same frame are ignored, so racing completion paths are safe.
     */
    public void finishFrame(int frameId, String outcome) {
        long now = SystemClock.elapsedRealtime();
        Frame finished;
        synchronized (lock) {
            Frame frame = activeFrames.remove(frameId);
            if (frame == null) {
                return;
            }
            finishFrameLocked(frame, now, outcome == null ? "discarded: no outcome given" : outcome);
            finished = frame;
        }
        Log.i(TAG, "frame#" + finished.id + " [" + finished.reason + "] -> " + finished.outcome
                + " in " + finished.durationMs() + "ms");
    }

    /** One-line stats summary, e.g. for showing in the phone UI. */
    public String statsSummary() {
        synchronized (lock) {
            long[] percentiles = sentPercentilesLocked();
            return "frames started=" + framesStarted + " sent=" + framesSent
                    + " discarded=" + framesDiscarded + " timeout=" + framesTimedOut
                    + (percentiles == null
                        ? ""
                        : " | sent-latency p50=" + percentiles[0] + "ms p90=" + percentiles[1]
                            + "ms p99=" + percentiles[2] + "ms max=" + percentiles[3] + "ms");
        }
    }

    // ---------------------------------------------------------------------

    private void addLineLocked(Frame frame, long now, String message) {
        if (frame.lines.size() >= MAX_LINES_PER_FRAME) {
            if (frame.lines.size() == MAX_LINES_PER_FRAME) {
                frame.lines.add("... line cap reached");
            }
            return;
        }
        frame.lines.add(String.format(Locale.US, "%+6dms [%s] %s",
                now - frame.startedAtMs, Thread.currentThread().getName(), message));
    }

    private void finishFrameLocked(Frame frame, long now, String outcome) {
        frame.finishedAtMs = now;
        frame.outcome = outcome;
        for (Map.Entry<String, Long> open : frame.openSpans.entrySet()) {
            frame.lines.add(String.format(Locale.US, "%+6dms span %s never ended (started at +%dms)",
                    now - frame.startedAtMs, open.getKey(), open.getValue() - frame.startedAtMs));
        }
        frame.openSpans.clear();
        addLineLocked(frame, now, "finished: " + outcome);

        if (frame.wasSent()) {
            framesSent++;
            sentDurations.addLast(frame.durationMs());
            while (sentDurations.size() > SENT_DURATIONS_WINDOW) {
                sentDurations.removeFirst();
            }
            insertSlowestLocked(frame);
        } else if (outcome.startsWith("timeout")) {
            framesTimedOut++;
        } else {
            framesDiscarded++;
        }

        recentFrames.addLast(frame);
        while (recentFrames.size() > RECENT_FRAMES_KEPT) {
            recentFrames.removeFirst();
        }
        exportDirty = true;
    }

    private void insertSlowestLocked(Frame frame) {
        slowestSentFrames.add(frame);
        Collections.sort(slowestSentFrames, (a, b) -> Long.compare(b.durationMs(), a.durationMs()));
        while (slowestSentFrames.size() > SLOWEST_FRAMES_KEPT) {
            slowestSentFrames.remove(slowestSentFrames.size() - 1);
        }
    }

    /** {p50, p90, p99, max} over the rolling sent-duration window, or null if empty. */
    private long[] sentPercentilesLocked() {
        if (sentDurations.isEmpty()) {
            return null;
        }
        List<Long> sorted = new ArrayList<>(sentDurations);
        Collections.sort(sorted);
        return new long[] {
            percentileOfSorted(sorted, 50),
            percentileOfSorted(sorted, 90),
            percentileOfSorted(sorted, 99),
            sorted.get(sorted.size() - 1),
        };
    }

    private static long percentileOfSorted(List<Long> sorted, int percentile) {
        int index = (int) Math.ceil(percentile / 100.0 * sorted.size()) - 1;
        return sorted.get(Math.max(0, Math.min(sorted.size() - 1, index)));
    }

    private void sweepTimedOutFrames() {
        long now = SystemClock.elapsedRealtime();
        List<Frame> timedOut = new ArrayList<>();
        synchronized (lock) {
            Iterator<Map.Entry<Integer, Frame>> iterator = activeFrames.entrySet().iterator();
            while (iterator.hasNext()) {
                Frame frame = iterator.next().getValue();
                if (now - frame.startedAtMs >= FRAME_TIMEOUT_MS) {
                    iterator.remove();
                    finishFrameLocked(frame, now, "timeout: never reported finished");
                    timedOut.add(frame);
                }
            }
        }
        for (Frame frame : timedOut) {
            Log.w(TAG, "frame#" + frame.id + " [" + frame.reason + "] timed out after "
                    + frame.durationMs() + "ms without being finished");
        }
    }

    private void exportLoop() {
        long lastExportAtMs = 0;
        while (true) {
            try {
                Thread.sleep(SWEEP_INTERVAL_MS);
            } catch (InterruptedException e) {
                return;
            }
            try {
                sweepTimedOutFrames();
                long now = SystemClock.elapsedRealtime();
                boolean shouldExport;
                synchronized (lock) {
                    shouldExport = exportDirty && exportDir != null && now - lastExportAtMs >= EXPORT_INTERVAL_MS;
                }
                if (shouldExport) {
                    lastExportAtMs = now;
                    exportToFile();
                }
            } catch (Throwable t) {
                Log.w(TAG, "export loop error", t);
            }
        }
    }

    private void exportToFile() {
        String content;
        File dir;
        synchronized (lock) {
            dir = exportDir;
            if (dir == null) {
                return;
            }
            content = buildExportLocked();
            exportDirty = false;
        }
        File target = new File(dir, EXPORT_FILE_NAME);
        File temp = new File(dir, EXPORT_FILE_NAME + ".tmp");
        try {
            try (Writer writer = new OutputStreamWriter(new FileOutputStream(temp), StandardCharsets.UTF_8)) {
                writer.write(content);
            }
            if (!temp.renameTo(target)) {
                Log.w(TAG, "failed to rename " + temp + " to " + target);
            }
        } catch (Throwable t) {
            Log.w(TAG, "failed to export frame timings", t);
        }
    }

    private String buildExportLocked() {
        SimpleDateFormat wallClockFormat = new SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US);
        StringBuilder out = new StringBuilder(64 * 1024);
        out.append("FrameTimings export at ").append(wallClockFormat.format(new Date())).append('\n');
        out.append(statsSummaryLocked()).append('\n');
        out.append('\n');

        out.append("=== slowest sent frames ===\n");
        for (Frame frame : slowestSentFrames) {
            appendFrameLocked(out, frame, wallClockFormat);
        }

        out.append("=== recent frames (oldest first) ===\n");
        for (Frame frame : recentFrames) {
            appendFrameLocked(out, frame, wallClockFormat);
        }
        return out.toString();
    }

    private String statsSummaryLocked() {
        long[] percentiles = sentPercentilesLocked();
        return "frames started=" + framesStarted + " sent=" + framesSent
                + " discarded=" + framesDiscarded + " timeout=" + framesTimedOut
                + " open=" + activeFrames.size()
                + (percentiles == null
                    ? ""
                    : "\nsent-frame latency (last " + sentDurations.size() + "): p50=" + percentiles[0]
                        + "ms p90=" + percentiles[1] + "ms p99=" + percentiles[2]
                        + "ms max=" + percentiles[3] + "ms");
    }

    private void appendFrameLocked(StringBuilder out, Frame frame, SimpleDateFormat wallClockFormat) {
        out.append("frame#").append(frame.id)
            .append(" [").append(frame.reason).append(']')
            .append(" started ").append(wallClockFormat.format(new Date(frame.startedWallClockMs)))
            .append(" duration ").append(frame.durationMs()).append("ms")
            .append(" outcome ").append(frame.outcome)
            .append('\n');
        for (String line : frame.lines) {
            out.append("  ").append(line).append('\n');
        }
    }
}
