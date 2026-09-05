package com.faceclaw.app;

import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;

/**
 * Desktop-style local GOP repair support for the Android G2 converter.
 *
 * The full source is encoded once. The encoded H.264 is split on actual IDR boundaries, audited
 * globally, and only GOPs participating in a failing NAL / 1-second / 5-second region are replaced.
 * Local retries tighten x264 VBV maxrate in 4 kbps steps, while global problem multipliers can make
 * a larger targeted cut when a window crossing GOP boundaries remains over the G2 transport gate.
 */
public final class FaceclawG2LocalRepair {
    // Normal convergence should stop because the global audit passes or every still-affected GOP
    // reaches the 45k repair floor. This is only an emergency infinite-loop guard.
    public static final int MAX_GLOBAL_ROUNDS = 32;
    public static final int MAX_LOCAL_TRIES = 16;
    public static final int MINIMUM_LOCAL_RATE_KBPS = 45;

    private static final byte[] START_CODE = new byte[]{0, 0, 0, 1};

    private FaceclawG2LocalRepair() {}

    public static final class Segment {
        public final int index;
        public final File path;
        public final int startFrame;
        public int frameCount;
        public final long startUs;
        public long endUs;

        Segment(int index, File path, int startFrame, long startUs) {
            this.index = index;
            this.path = path;
            this.startFrame = startFrame;
            this.startUs = startUs;
        }

        public int endFrameInclusive() {
            return startFrame + frameCount - 1;
        }
    }

    public static final class Plan {
        public final List<Segment> segments;
        public final int frames;
        public final long durationUs;

        Plan(List<Segment> segments, int frames, long durationUs) {
            this.segments = segments;
            this.frames = frames;
            this.durationUs = durationUs;
        }
    }

    public static final class ProblemRange {
        public final int startFrame;
        public final int endFrame;
        public final double suggestedMultiplier;
        public final String reason;

        ProblemRange(int startFrame, int endFrame, double suggestedMultiplier, String reason) {
            this.startFrame = startFrame;
            this.endFrame = endFrame;
            this.suggestedMultiplier = suggestedMultiplier;
            this.reason = reason;
        }
    }

    public static final class Audit {
        public final int frames;
        public final int idrFrames;
        public final int maxTransportNal;
        public final int transportOverCeiling;
        public final double worst1WritesPerSec;
        public final double worst5WritesPerSec;
        public final List<ProblemRange> problems;

        Audit(int frames, int idrFrames, int maxTransportNal, int transportOverCeiling,
              double worst1WritesPerSec, double worst5WritesPerSec,
              List<ProblemRange> problems) {
            this.frames = frames;
            this.idrFrames = idrFrames;
            this.maxTransportNal = maxTransportNal;
            this.transportOverCeiling = transportOverCeiling;
            this.worst1WritesPerSec = worst1WritesPerSec;
            this.worst5WritesPerSec = worst5WritesPerSec;
            this.problems = problems;
        }

        public boolean passesTransport() {
            return frames > 0
                    && transportOverCeiling == 0
                    && worst1WritesPerSec <= FaceclawG2VideoBitstream.MAX_1SEC_WRITES + 1e-6
                    && worst5WritesPerSec <= FaceclawG2VideoBitstream.MAX_5SEC_WRITES + 1e-6;
        }

        public String failure() {
            if (frames <= 0) return "No H.264 VCL frames found";
            if (transportOverCeiling > 0) {
                return "NAL ceiling failed: " + transportOverCeiling + " NAL(s) exceed "
                        + FaceclawG2VideoBitstream.NAL_CEILING + " bytes";
            }
            if (worst1WritesPerSec > FaceclawG2VideoBitstream.MAX_1SEC_WRITES + 1e-6) {
                return String.format(Locale.US, "1-second BLE density failed: %.2f > %.2f writes/s",
                        worst1WritesPerSec, FaceclawG2VideoBitstream.MAX_1SEC_WRITES);
            }
            if (worst5WritesPerSec > FaceclawG2VideoBitstream.MAX_5SEC_WRITES + 1e-6) {
                return String.format(Locale.US, "5-second BLE density failed: %.2f > %.2f writes/s",
                        worst5WritesPerSec, FaceclawG2VideoBitstream.MAX_5SEC_WRITES);
            }
            return null;
        }
    }

    public static Plan extractInitialGops(File mp4, File segmentsDir, File assembled, int fps)
            throws IOException {
        if (fps <= 0) throw new IllegalArgumentException("Invalid FPS " + fps);
        deleteTree(segmentsDir);
        if (!segmentsDir.isDirectory() && !segmentsDir.mkdirs()) {
            throw new IOException("Could not create local repair segment directory");
        }

        MediaExtractor extractor = new MediaExtractor();
        BufferedOutputStream currentOut = null;
        try {
            extractor.setDataSource(mp4.getAbsolutePath());
            int videoTrack = -1;
            MediaFormat format = null;
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat candidate = extractor.getTrackFormat(i);
                String mime = candidate.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")) {
                    videoTrack = i;
                    format = candidate;
                    break;
                }
            }
            if (videoTrack < 0 || format == null) {
                throw new IOException("Converted file has no video track");
            }
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (!MediaFormat.MIMETYPE_VIDEO_AVC.equals(mime)) {
                throw new IOException("Converted track is not H.264/AVC: " + mime);
            }

            long declaredDurationUs = format.containsKey(MediaFormat.KEY_DURATION)
                    ? format.getLong(MediaFormat.KEY_DURATION) : 0;
            List<byte[]> csd = readCodecSpecificData(format);

            extractor.selectTrack(videoTrack);
            ByteBuffer sample = ByteBuffer.allocateDirect(1024 * 1024);
            List<Segment> segments = new ArrayList<>();
            Segment current = null;
            int globalFrame = 0;
            long lastPtsUs = 0;

            while (true) {
                sample.clear();
                int size = extractor.readSampleData(sample, 0);
                if (size < 0) break;
                if (size > sample.capacity()) {
                    throw new IOException("H.264 sample exceeds local repair buffer: " + size);
                }
                byte[] raw = new byte[size];
                sample.position(0);
                sample.limit(size);
                sample.get(raw);
                List<byte[]> nals = splitNalUnits(raw);
                if (nals.isEmpty()) throw new IOException("Could not parse H.264 sample");

                int vclCount = 0;
                boolean hasIdr = false;
                for (byte[] nal : nals) {
                    if (nal.length == 0) continue;
                    int type = nal[0] & 0x1f;
                    if (type == 1 || type == 5) vclCount++;
                    if (type == 5) hasIdr = true;
                }
                if (vclCount > 1) {
                    throw new IOException("Hardware encoder produced multiple VCL slices in one frame; G2 requires single-slice frames");
                }

                long ptsUs = extractor.getSampleTime();
                if (ptsUs >= 0) lastPtsUs = Math.max(lastPtsUs, ptsUs);
                boolean sync = (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0;

                if (vclCount == 1 && sync) {
                    if (!hasIdr) {
                        throw new IOException("Sync sample did not contain an IDR frame");
                    }
                    if (currentOut != null) {
                        currentOut.flush();
                        currentOut.close();
                        currentOut = null;
                    }
                    if (current != null) current.endUs = Math.max(current.startUs, ptsUs);

                    File segmentFile = new File(segmentsDir,
                            String.format(Locale.US, "seg_%05d.h264", segments.size()));
                    current = new Segment(segments.size(), segmentFile, globalFrame, Math.max(0, ptsUs));
                    segments.add(current);
                    currentOut = new BufferedOutputStream(new FileOutputStream(segmentFile), 256 * 1024);
                    if (!hasType(nals, 7)) writeTypes(csd, 7, currentOut);
                    if (!hasType(nals, 8)) writeTypes(csd, 8, currentOut);
                }

                if (vclCount == 1 && current == null) {
                    throw new IOException("Encoded stream did not start with an IDR GOP");
                }

                if (currentOut != null) {
                    for (byte[] nal : nals) writeNal(nal, currentOut);
                }
                if (vclCount == 1) {
                    current.frameCount++;
                    globalFrame++;
                }
                extractor.advance();
            }

            if (currentOut != null) {
                currentOut.flush();
                currentOut.close();
                currentOut = null;
            }
            if (segments.isEmpty() || globalFrame <= 0) {
                throw new IOException("No IDR GOP segments were extracted");
            }
            long durationUs = declaredDurationUs > 0
                    ? declaredDurationUs
                    : lastPtsUs + Math.max(1, 1_000_000L / fps);
            Segment last = segments.get(segments.size() - 1);
            last.endUs = Math.max(last.startUs, durationUs);
            for (Segment segment : segments) {
                if (segment.frameCount <= 0) {
                    throw new IOException("Empty GOP segment " + segment.index);
                }
            }

            Plan plan = new Plan(segments, globalFrame, durationUs);
            assemble(plan, assembled);
            return plan;
        } finally {
            if (currentOut != null) {
                try { currentOut.close(); } catch (Throwable ignored) {}
            }
            extractor.release();
        }
    }

    public static Audit auditAnnexB(File path, int fps) throws IOException {
        IntList frameWrites = new IntList();
        IntList frameMaxNal = new IntList();
        ScannerState state = new ScannerState(frameWrites, frameMaxNal);
        byte[] buffer = new byte[1024 * 1024];
        boolean inNal = false;
        boolean needHeader = false;
        int nalType = 0;
        int nalBytes = 0;
        int zeroRun = 0;

        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(path), buffer.length)) {
            int read;
            while ((read = input.read(buffer)) > 0) {
                for (int i = 0; i < read; i++) {
                    int b = buffer[i] & 0xff;
                    if (b == 0) {
                        zeroRun++;
                        continue;
                    }
                    if (b == 1 && zeroRun >= 2) {
                        if (inNal) finishNal(nalType, nalBytes, state);
                        inNal = false;
                        needHeader = true;
                        nalBytes = 0;
                        zeroRun = 0;
                        continue;
                    }
                    if (needHeader) {
                        nalType = b & 0x1f;
                        nalBytes = 1;
                        inNal = true;
                        needHeader = false;
                        zeroRun = 0;
                        continue;
                    }
                    if (inNal) {
                        nalBytes += zeroRun;
                        zeroRun = 0;
                        nalBytes++;
                    } else {
                        zeroRun = 0;
                    }
                }
            }
            if (inNal) finishNal(nalType, nalBytes, state);
        }

        if (state.pendingWrites > 0 && frameWrites.size > 0) {
            int last = frameWrites.size - 1;
            frameWrites.values[last] += state.pendingWrites;
            frameMaxNal.values[last] = Math.max(frameMaxNal.values[last], state.pendingMaxNal);
        }

        double worst1 = maxWindowRate(frameWrites, fps, Math.min(fps, frameWrites.size));
        double worst5 = maxWindowRate(frameWrites, fps, Math.min(fps * 5, frameWrites.size));
        List<ProblemRange> problems = buildProblems(frameWrites, frameMaxNal, fps);
        return new Audit(frameWrites.size, state.idrFrames, state.maxTransportNal,
                state.transportOverCeiling, worst1, worst5, problems);
    }

    public static List<Integer> affectedSegments(Plan plan, Audit audit) {
        LinkedHashSet<Integer> indexes = new LinkedHashSet<>();
        for (ProblemRange problem : audit.problems) {
            for (Segment segment : plan.segments) {
                if (segment.endFrameInclusive() < problem.startFrame) continue;
                if (segment.startFrame > problem.endFrame) break;
                indexes.add(segment.index);
            }
        }
        return new ArrayList<>(indexes);
    }

    /** Returns the strongest global problem multiplier touching this GOP, or 1.0 if none. */
    public static double suggestedMultiplierForSegment(Plan plan, Audit audit, int segmentIndex) {
        if (plan == null || audit == null || segmentIndex < 0 || segmentIndex >= plan.segments.size()) {
            return 1.0;
        }
        Segment segment = plan.segments.get(segmentIndex);
        double multiplier = 1.0;
        for (ProblemRange problem : audit.problems) {
            if (segment.endFrameInclusive() < problem.startFrame) continue;
            if (segment.startFrame > problem.endFrame) continue;
            multiplier = Math.min(multiplier, problem.suggestedMultiplier);
        }
        return Math.min(1.0, Math.max(0.55, multiplier));
    }

    public static int firstRepairRateKbps(Audit localAudit, Integer previousRateKbps,
                                           int normalRateKbps, double globalMultiplier) {
        globalMultiplier = Math.min(1.0, Math.max(0.55, globalMultiplier));

        if (previousRateKbps != null) {
            // Preserve the desktop 4k downward step, but if the global audit says the crossing
            // window needs a larger reduction, take that stronger cut immediately.
            int stepped = Math.max(MINIMUM_LOCAL_RATE_KBPS, previousRateKbps - 4);
            int globalSuggested = previousRateKbps;
            if (globalMultiplier < 0.999) {
                globalSuggested = (int) Math.floor(previousRateKbps * globalMultiplier);
                globalSuggested = Math.max(MINIMUM_LOCAL_RATE_KBPS, globalSuggested);
                if (globalSuggested >= previousRateKbps) {
                    globalSuggested = Math.max(MINIMUM_LOCAL_RATE_KBPS, previousRateKbps - 4);
                }
            }
            return Math.max(MINIMUM_LOCAL_RATE_KBPS, Math.min(stepped, globalSuggested));
        }

        double ratio = globalMultiplier;
        if (localAudit.worst5WritesPerSec > FaceclawG2VideoBitstream.MAX_5SEC_WRITES) {
            ratio = Math.min(ratio,
                    FaceclawG2VideoBitstream.MAX_5SEC_WRITES / localAudit.worst5WritesPerSec);
        }
        if (localAudit.worst1WritesPerSec > FaceclawG2VideoBitstream.MAX_1SEC_WRITES) {
            ratio = Math.min(ratio,
                    FaceclawG2VideoBitstream.MAX_1SEC_WRITES / localAudit.worst1WritesPerSec);
        }
        if (localAudit.maxTransportNal > FaceclawG2VideoBitstream.NAL_CEILING) {
            ratio = Math.min(ratio,
                    FaceclawG2VideoBitstream.NAL_CEILING / (double) localAudit.maxTransportNal);
        }

        int cap = Math.max(MINIMUM_LOCAL_RATE_KBPS, normalRateKbps - 4);
        if (ratio < 0.999) {
            int start = (int) Math.floor(normalRateKbps * ratio * 0.97);
            start = Math.min(start, cap);
            // As on desktop, 60k is only the floor for the first attempt on an untouched GOP.
            start = Math.max(60, start);
            return Math.max(MINIMUM_LOCAL_RATE_KBPS, start);
        }
        return cap;
    }

    public static int retryRateKbps(int startRateKbps, int localTry) {
        return Math.max(MINIMUM_LOCAL_RATE_KBPS, startRateKbps - ((localTry - 1) * 4));
    }

    public static void replaceSegment(File replacement, Segment segment) throws IOException {
        File temp = new File(segment.path.getParentFile(), segment.path.getName() + ".replace");
        copy(replacement, temp);
        if (segment.path.exists() && !segment.path.delete()) {
            temp.delete();
            throw new IOException("Could not remove old GOP segment " + segment.index);
        }
        if (!temp.renameTo(segment.path)) {
            copy(temp, segment.path);
            temp.delete();
        }
    }

    public static void assemble(Plan plan, File destination) throws IOException {
        File parent = destination.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IOException("Could not create final candidate directory");
        }
        try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination), 1024 * 1024)) {
            byte[] buffer = new byte[1024 * 1024];
            for (Segment segment : plan.segments) {
                try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(segment.path), buffer.length)) {
                    int read;
                    while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
                }
            }
        }
    }

    public static FaceclawG2VideoBitstream.Result toResult(Audit audit, File output,
                                                            int fps, long durationUs) {
        double actualFps = durationUs > 0 ? audit.frames * 1_000_000.0 / durationUs : 0;
        double playbackDurationUs = audit.frames * 1_000_000.0 / fps;
        double durationDriftMs = durationUs > 0
                ? Math.abs(playbackDurationUs - durationUs) / 1000.0 : 0;
        double allowedDriftMs = Math.max(100.0, 2000.0 / fps);
        String failure = audit.failure();
        if (failure == null && durationUs > 0 && durationDriftMs > allowedDriftMs) {
            failure = String.format(Locale.US,
                    "FPS sync failed: %.1f ms duration drift at requested %d FPS (actual %.5f FPS)",
                    durationDriftMs, fps, actualFps);
        }
        boolean passed = failure == null;
        return new FaceclawG2VideoBitstream.Result(
                passed,
                failure,
                audit.frames,
                audit.idrFrames,
                audit.maxTransportNal,
                audit.transportOverCeiling,
                audit.worst1WritesPerSec,
                audit.worst5WritesPerSec,
                66,
                false,
                passed ? output.length() : 0,
                durationUs,
                actualFps,
                durationDriftMs);
    }

    public static void deleteTree(File file) {
        if (file == null || !file.exists()) return;
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) deleteTree(child);
            }
        }
        try { file.delete(); } catch (Throwable ignored) {}
    }

    private static final class ScannerState {
        final IntList frameWrites;
        final IntList frameMaxNal;
        int pendingWrites;
        int pendingMaxNal;
        int idrFrames;
        int maxTransportNal;
        int transportOverCeiling;

        ScannerState(IntList frameWrites, IntList frameMaxNal) {
            this.frameWrites = frameWrites;
            this.frameMaxNal = frameMaxNal;
        }
    }

    private static void finishNal(int type, int bytes, ScannerState state) {
        if (bytes <= 0) return;
        boolean vcl = type == 1 || type == 5;
        boolean transported = type != 6 && type != 9;
        int writes = 0;
        if (transported) {
            writes = writesFor(bytes);
            state.maxTransportNal = Math.max(state.maxTransportNal, bytes);
            if (bytes > FaceclawG2VideoBitstream.NAL_CEILING) state.transportOverCeiling++;
        }
        if (vcl) {
            state.frameWrites.add(state.pendingWrites + writes);
            state.frameMaxNal.add(Math.max(state.pendingMaxNal, bytes));
            state.pendingWrites = 0;
            state.pendingMaxNal = 0;
            if (type == 5) state.idrFrames++;
        } else if (transported) {
            state.pendingWrites += writes;
            state.pendingMaxNal = Math.max(state.pendingMaxNal, bytes);
        }
    }

    private static int writesFor(int nalBytes) {
        return (nalBytes + FaceclawG2VideoBitstream.MODE11_HEADER
                + FaceclawG2VideoBitstream.PHYSICAL_PAYLOAD - 1)
                / FaceclawG2VideoBitstream.PHYSICAL_PAYLOAD;
    }

    private static double maxWindowRate(IntList values, int fps, int width) {
        if (values.size == 0 || width <= 0) return 0;
        width = Math.min(width, values.size);
        long sum = 0;
        for (int i = 0; i < width; i++) sum += values.values[i];
        long best = sum;
        for (int i = width; i < values.size; i++) {
            sum += values.values[i];
            sum -= values.values[i - width];
            if (sum > best) best = sum;
        }
        return best / (width / (double) fps);
    }

    private static List<ProblemRange> buildProblems(IntList writes, IntList maxNal, int fps) {
        int n = writes.size;
        double[] need = new double[n];
        byte[] flags = new byte[n];
        for (int i = 0; i < n; i++) need[i] = 1.0;

        for (int i = 0; i < n; i++) {
            int size = maxNal.values[i];
            if (size > FaceclawG2VideoBitstream.NAL_CEILING) {
                double factor = 0.94 * FaceclawG2VideoBitstream.NAL_CEILING / (double) size;
                if (factor > 0.90) factor = 0.90;
                mark(need, flags, i - 1, i + 1, factor, (byte) 1);
            }
        }
        markWindows(writes, fps, Math.min(fps, n),
                FaceclawG2VideoBitstream.MAX_1SEC_WRITES, need, flags, (byte) 2, 0.92, 2);
        markWindows(writes, fps, Math.min(fps * 5, n),
                FaceclawG2VideoBitstream.MAX_5SEC_WRITES, need, flags, (byte) 4, 0.93, 2);

        List<ProblemRange> result = new ArrayList<>();
        int pos = 0;
        while (pos < n) {
            if (flags[pos] == 0) {
                pos++;
                continue;
            }
            int start = pos;
            int end = pos;
            double minFactor = need[pos];
            byte combined = flags[pos];
            pos++;
            while (pos < n && flags[pos] != 0) {
                end = pos;
                minFactor = Math.min(minFactor, need[pos]);
                combined |= flags[pos];
                pos++;
            }
            result.add(new ProblemRange(start, end, minFactor, reason(combined)));
        }
        return result;
    }

    private static void markWindows(IntList writes, int fps, int width, double maxPerSecond,
                                    double[] need, byte[] flags, byte flag,
                                    double factorCap, int pad) {
        int n = writes.size;
        if (n == 0 || width <= 0) return;
        width = Math.min(width, n);
        double seconds = width / (double) fps;
        double limit = maxPerSecond * seconds;
        long sum = 0;
        for (int i = 0; i < n; i++) {
            sum += writes.values[i];
            if (i >= width) sum -= writes.values[i - width];
            if (i < width - 1) continue;
            if (sum > limit + 1e-6) {
                int start = i - width + 1;
                double factor = 0.95 * limit / sum;
                if (factor > factorCap) factor = factorCap;
                mark(need, flags, start - pad, i + pad, factor, flag);
            }
        }
    }

    private static void mark(double[] need, byte[] flags, int start, int end,
                             double factor, byte flag) {
        if (need.length == 0) return;
        start = Math.max(0, start);
        end = Math.min(need.length - 1, end);
        factor = clampFactor(factor);
        for (int i = start; i <= end; i++) {
            need[i] = Math.min(need[i], factor);
            flags[i] |= flag;
        }
    }

    private static double clampFactor(double factor) {
        factor = Math.min(0.98, Math.max(0.55, factor));
        return Math.floor(factor * 100.0) / 100.0;
    }

    private static String reason(byte flags) {
        List<String> values = new ArrayList<>();
        if ((flags & 1) != 0) values.add("NAL");
        if ((flags & 2) != 0) values.add("1SEC");
        if ((flags & 4) != 0) values.add("5SEC");
        return join(values, "+");
    }

    private static final class IntList {
        int[] values = new int[4096];
        int size;

        void add(int value) {
            if (size >= values.length) {
                int[] next = new int[values.length * 2];
                System.arraycopy(values, 0, next, 0, values.length);
                values = next;
            }
            values[size++] = value;
        }
    }

    private static List<byte[]> readCodecSpecificData(MediaFormat format) throws IOException {
        List<byte[]> result = new ArrayList<>();
        for (int i = 0; i < 2; i++) {
            String key = "csd-" + i;
            if (!format.containsKey(key)) continue;
            ByteBuffer buffer = format.getByteBuffer(key);
            if (buffer == null) continue;
            ByteBuffer copy = buffer.duplicate();
            byte[] raw = new byte[copy.remaining()];
            copy.get(raw);
            result.addAll(splitNalUnits(raw));
        }
        return result;
    }

    private static void writeTypes(List<byte[]> nals, int type, BufferedOutputStream output)
            throws IOException {
        for (byte[] nal : nals) {
            if (nal.length > 0 && (nal[0] & 0x1f) == type) writeNal(nal, output);
        }
    }

    private static boolean hasType(List<byte[]> nals, int type) {
        for (byte[] nal : nals) {
            if (nal.length > 0 && (nal[0] & 0x1f) == type) return true;
        }
        return false;
    }

    private static void writeNal(byte[] nal, BufferedOutputStream output) throws IOException {
        if (nal.length == 0) return;
        output.write(START_CODE);
        output.write(nal);
    }

    private static List<byte[]> splitNalUnits(byte[] raw) throws IOException {
        List<byte[]> annex = splitAnnexB(raw);
        if (!annex.isEmpty()) return annex;
        for (int prefix : new int[]{4, 2, 1}) {
            List<byte[]> result = splitLengthPrefixed(raw, prefix);
            if (result != null && !result.isEmpty()) return result;
        }
        if (raw.length > 0 && validNalHeader(raw[0])) {
            List<byte[]> single = new ArrayList<>();
            single.add(raw);
            return single;
        }
        throw new IOException("Unsupported H.264 sample framing");
    }

    private static List<byte[]> splitAnnexB(byte[] raw) {
        List<byte[]> result = new ArrayList<>();
        int start = findStartCode(raw, 0);
        if (start < 0) return result;
        while (start >= 0) {
            int nalStart = start + startCodeLength(raw, start);
            int next = findStartCode(raw, nalStart);
            int end = next >= 0 ? next : raw.length;
            while (end > nalStart && raw[end - 1] == 0) end--;
            if (end > nalStart) {
                byte[] nal = new byte[end - nalStart];
                System.arraycopy(raw, nalStart, nal, 0, nal.length);
                result.add(nal);
            }
            start = next;
        }
        return result;
    }

    private static List<byte[]> splitLengthPrefixed(byte[] raw, int prefix) {
        List<byte[]> result = new ArrayList<>();
        int pos = 0;
        while (pos < raw.length) {
            if (pos + prefix > raw.length) return null;
            int size = 0;
            for (int i = 0; i < prefix; i++) size = (size << 8) | (raw[pos + i] & 0xff);
            pos += prefix;
            if (size <= 0 || pos + size > raw.length || !validNalHeader(raw[pos])) return null;
            byte[] nal = new byte[size];
            System.arraycopy(raw, pos, nal, 0, size);
            result.add(nal);
            pos += size;
        }
        return result;
    }

    private static boolean validNalHeader(byte value) {
        int type = value & 0x1f;
        return (value & 0x80) == 0 && type > 0 && type < 24;
    }

    private static int findStartCode(byte[] data, int from) {
        for (int i = Math.max(0, from); i + 2 < data.length; i++) {
            if (data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 1) return i;
            if (i + 3 < data.length && data[i] == 0 && data[i + 1] == 0
                    && data[i + 2] == 0 && data[i + 3] == 1) return i;
        }
        return -1;
    }

    private static int startCodeLength(byte[] data, int at) {
        return at + 3 < data.length && data[at] == 0 && data[at + 1] == 0
                && data[at + 2] == 0 && data[at + 3] == 1 ? 4 : 3;
    }

    private static void copy(File source, File destination) throws IOException {
        try (BufferedInputStream input = new BufferedInputStream(new FileInputStream(source), 256 * 1024);
             BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(destination), 256 * 1024)) {
            byte[] buffer = new byte[256 * 1024];
            int read;
            while ((read = input.read(buffer)) > 0) output.write(buffer, 0, read);
        }
    }

    private static String join(List<String> values, String separator) {
        StringBuilder result = new StringBuilder();
        for (int i = 0; i < values.size(); i++) {
            if (i > 0) result.append(separator);
            result.append(values.get(i));
        }
        return result.toString();
    }
}
