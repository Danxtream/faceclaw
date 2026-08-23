package com.faceclaw.app;

import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;

import java.io.BufferedOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;

/**
 * Converts the H.264 track produced by MediaCodec/Transformer into the Annex-B
 * elementary stream consumed by Faceclaw, while enforcing the proven G2
 * transport limits from G2_VIDEO_MERGED.ps.txt.
 */
public final class FaceclawG2VideoBitstream {
    public static final int WIDTH = 320;
    public static final int HEIGHT = 192;
    public static final int NAL_CEILING = 2980;
    public static final double MAX_1SEC_WRITES = 75.0;
    public static final double MAX_5SEC_WRITES = 61.0;
    public static final int PHYSICAL_PAYLOAD = 230;
    public static final int MODE11_HEADER = 10;

    private static final byte[] START_CODE = new byte[] { 0, 0, 0, 1 };

    private FaceclawG2VideoBitstream() {}

    public static final class Result {
        public final boolean passed;
        public final String failure;
        public final int frames;
        public final int idrFrames;
        public final int maxTransportNal;
        public final int transportOverCeiling;
        public final double worst1WritesPerSec;
        public final double worst5WritesPerSec;
        public final int profileIdc;
        public final boolean cabac;
        public final long outputBytes;
        public final long durationUs;
        public final double actualFps;

        Result(boolean passed, String failure, int frames, int idrFrames,
               int maxTransportNal, int transportOverCeiling,
               double worst1WritesPerSec, double worst5WritesPerSec,
               int profileIdc, boolean cabac, long outputBytes,
               long durationUs, double actualFps) {
            this.passed = passed;
            this.failure = failure;
            this.frames = frames;
            this.idrFrames = idrFrames;
            this.maxTransportNal = maxTransportNal;
            this.transportOverCeiling = transportOverCeiling;
            this.worst1WritesPerSec = worst1WritesPerSec;
            this.worst5WritesPerSec = worst5WritesPerSec;
            this.profileIdc = profileIdc;
            this.cabac = cabac;
            this.outputBytes = outputBytes;
            this.durationUs = durationUs;
            this.actualFps = actualFps;
        }
    }

    private static final class Audit {
        final int fps;
        final List<Integer> frameWrites = new ArrayList<>();
        final List<Integer> frameMaxNal = new ArrayList<>();
        int pendingWrites;
        int pendingMaxNal;
        int frames;
        int idrFrames;
        int maxTransportNal;
        int transportOverCeiling;
        int profileIdc = -1;
        boolean cabac;

        Audit(int fps) {
            this.fps = fps;
        }

        void nal(byte[] data, int offset, int length) throws IOException {
            if (length <= 0) return;
            int type = data[offset] & 0x1f;
            if (type == 7 && length >= 2) {
                profileIdc = data[offset + 1] & 0xff;
            } else if (type == 8) {
                cabac |= ppsUsesCabac(data, offset, length);
            }

            boolean vcl = type == 1 || type == 5;
            boolean transported = type != 6 && type != 9;
            int writes = 0;
            if (transported) {
                writes = writesFor(length);
                maxTransportNal = Math.max(maxTransportNal, length);
                if (length > NAL_CEILING) transportOverCeiling++;
            }

            if (vcl) {
                frameWrites.add(pendingWrites + writes);
                frameMaxNal.add(Math.max(pendingMaxNal, length));
                pendingWrites = 0;
                pendingMaxNal = 0;
                frames++;
                if (type == 5) idrFrames++;
            } else if (transported) {
                pendingWrites += writes;
                pendingMaxNal = Math.max(pendingMaxNal, length);
            }
        }

        void finish() {
            if (pendingWrites > 0 && !frameWrites.isEmpty()) {
                int last = frameWrites.size() - 1;
                frameWrites.set(last, frameWrites.get(last) + pendingWrites);
                frameMaxNal.set(last, Math.max(frameMaxNal.get(last), pendingMaxNal));
                pendingWrites = 0;
                pendingMaxNal = 0;
            }
        }

        double maxWritesPerSecond(int widthFrames) {
            if (frameWrites.isEmpty()) return 0;
            int width = Math.min(Math.max(1, widthFrames), frameWrites.size());
            long sum = 0;
            for (int i = 0; i < width; i++) sum += frameWrites.get(i);
            long best = sum;
            for (int i = width; i < frameWrites.size(); i++) {
                sum += frameWrites.get(i);
                sum -= frameWrites.get(i - width);
                if (sum > best) best = sum;
            }
            return best / (width / (double) fps);
        }
    }

    public static Result extractAndAudit(File mp4, File annexB, int requestedFps) throws IOException {
        if (requestedFps < 1 || requestedFps > 60) throw new IllegalArgumentException("Invalid FPS " + requestedFps);
        MediaExtractor extractor = new MediaExtractor();
        long durationUs = 0;
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
            if (videoTrack < 0 || format == null) throw new IOException("Converted file has no video track");
            String mime = format.getString(MediaFormat.KEY_MIME);
            if (!MediaFormat.MIMETYPE_VIDEO_AVC.equals(mime)) {
                throw new IOException("Converted track is not H.264/AVC: " + mime);
            }
            if (format.containsKey(MediaFormat.KEY_DURATION)) durationUs = format.getLong(MediaFormat.KEY_DURATION);

            List<byte[]> csd = new ArrayList<>();
            for (int i = 0; i < 2; i++) {
                String key = "csd-" + i;
                if (!format.containsKey(key)) continue;
                ByteBuffer b = format.getByteBuffer(key);
                if (b == null) continue;
                ByteBuffer copy = b.duplicate();
                byte[] raw = new byte[copy.remaining()];
                copy.get(raw);
                csd.addAll(splitNalUnits(raw));
            }

            extractor.selectTrack(videoTrack);
            Audit audit = new Audit(requestedFps);
            ByteBuffer sample = ByteBuffer.allocateDirect(1024 * 1024);
            long maxSample = 0;
            long lastPtsUs = 0;
            try (BufferedOutputStream output = new BufferedOutputStream(new FileOutputStream(annexB), 1024 * 1024)) {
                while (true) {
                    sample.clear();
                    int size = extractor.readSampleData(sample, 0);
                    if (size < 0) break;
                    maxSample = Math.max(maxSample, size);
                    if (size > sample.capacity()) throw new IOException("H.264 sample exceeds buffer: " + size);
                    byte[] raw = new byte[size];
                    sample.position(0);
                    sample.limit(size);
                    sample.get(raw);
                    List<byte[]> nals = splitNalUnits(raw);
                    if (nals.isEmpty()) throw new IOException("Could not parse H.264 sample");

                    boolean sync = (extractor.getSampleFlags() & MediaExtractor.SAMPLE_FLAG_SYNC) != 0;
                    boolean hasSps = hasType(nals, 7);
                    boolean hasPps = hasType(nals, 8);
                    if (sync) {
                        if (!hasSps) writeTypes(csd, 7, output, audit);
                        if (!hasPps) writeTypes(csd, 8, output, audit);
                    }
                    for (byte[] nal : nals) writeNal(nal, output, audit);
                    lastPtsUs = Math.max(lastPtsUs, extractor.getSampleTime());
                    extractor.advance();
                }
                output.flush();
            } catch (IOException error) {
                annexB.delete();
                throw error;
            }
            audit.finish();

            if (durationUs <= 0) durationUs = lastPtsUs > 0 ? lastPtsUs + (1_000_000L / requestedFps) : 0;
            double actualFps = durationUs > 0 ? audit.frames * 1_000_000.0 / durationUs : 0;
            double worst1 = audit.maxWritesPerSecond(requestedFps);
            double worst5 = audit.maxWritesPerSecond(requestedFps * 5);

            String failure = null;
            if (audit.frames <= 0) failure = "No H.264 VCL frames found";
            else if (audit.profileIdc != 66) failure = "Hardware encoder did not produce Baseline H.264 (profile_idc=" + audit.profileIdc + ")";
            else if (audit.cabac) failure = "Hardware encoder enabled CABAC; G2 requires CAVLC";
            else if (audit.transportOverCeiling > 0) failure = "NAL ceiling failed: " + audit.transportOverCeiling + " NAL(s) exceed " + NAL_CEILING + " bytes";
            else if (worst1 > MAX_1SEC_WRITES + 1e-6) failure = String.format(java.util.Locale.US, "1-second BLE density failed: %.2f > %.2f writes/s", worst1, MAX_1SEC_WRITES);
            else if (worst5 > MAX_5SEC_WRITES + 1e-6) failure = String.format(java.util.Locale.US, "5-second BLE density failed: %.2f > %.2f writes/s", worst5, MAX_5SEC_WRITES);
            else if (durationUs > 0 && Math.abs(actualFps - requestedFps) > Math.max(0.15, requestedFps * 0.015)) {
                failure = String.format(java.util.Locale.US, "Output frame rate %.3f does not match requested %d fps", actualFps, requestedFps);
            }

            boolean passed = failure == null;
            if (!passed) annexB.delete();
            return new Result(passed, failure, audit.frames, audit.idrFrames,
                    audit.maxTransportNal, audit.transportOverCeiling,
                    worst1, worst5, audit.profileIdc, audit.cabac,
                    passed ? annexB.length() : 0, durationUs, actualFps);
        } finally {
            extractor.release();
        }
    }

    private static int writesFor(int nalBytes) {
        return (nalBytes + MODE11_HEADER + PHYSICAL_PAYLOAD - 1) / PHYSICAL_PAYLOAD;
    }

    private static void writeTypes(List<byte[]> nals, int wantedType, BufferedOutputStream out, Audit audit) throws IOException {
        for (byte[] nal : nals) if (nal.length > 0 && (nal[0] & 0x1f) == wantedType) writeNal(nal, out, audit);
    }

    private static boolean hasType(List<byte[]> nals, int wantedType) {
        for (byte[] nal : nals) if (nal.length > 0 && (nal[0] & 0x1f) == wantedType) return true;
        return false;
    }

    private static void writeNal(byte[] nal, BufferedOutputStream out, Audit audit) throws IOException {
        if (nal.length == 0) return;
        out.write(START_CODE);
        out.write(nal);
        audit.nal(nal, 0, nal.length);
    }

    /** Supports Annex-B or AVCC samples with 4/2/1-byte NAL lengths. */
    private static List<byte[]> splitNalUnits(byte[] raw) throws IOException {
        List<byte[]> annex = splitAnnexB(raw);
        if (!annex.isEmpty()) return annex;
        for (int prefix : new int[] { 4, 2, 1 }) {
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
            int code = startCodeLength(raw, start);
            int nalStart = start + code;
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
            if (i + 3 < data.length && data[i] == 0 && data[i + 1] == 0 && data[i + 2] == 0 && data[i + 3] == 1) return i;
        }
        return -1;
    }

    private static int startCodeLength(byte[] data, int at) {
        return at + 3 < data.length && data[at] == 0 && data[at + 1] == 0 && data[at + 2] == 0 && data[at + 3] == 1 ? 4 : 3;
    }

    /** Parse PPS pic_parameter_set_id, seq_parameter_set_id, then entropy_coding_mode_flag. */
    private static boolean ppsUsesCabac(byte[] nal, int offset, int length) throws IOException {
        if (length <= 1) return false;
        byte[] rbsp = new byte[length - 1];
        int n = 0;
        int zeros = 0;
        for (int i = offset + 1; i < offset + length; i++) {
            int b = nal[i] & 0xff;
            if (zeros >= 2 && b == 0x03) {
                zeros = 0;
                continue;
            }
            rbsp[n++] = (byte) b;
            zeros = b == 0 ? zeros + 1 : 0;
        }
        BitReader bits = new BitReader(rbsp, n);
        bits.readUe();
        bits.readUe();
        return bits.readBit() != 0;
    }

    private static final class BitReader {
        final byte[] data;
        final int length;
        int bit;
        BitReader(byte[] data, int length) { this.data = data; this.length = length; }
        int readBit() throws IOException {
            if (bit >= length * 8) throw new IOException("Truncated PPS");
            int value = (data[bit >> 3] >> (7 - (bit & 7))) & 1;
            bit++;
            return value;
        }
        int readUe() throws IOException {
            int leading = 0;
            while (readBit() == 0) {
                leading++;
                if (leading > 31) throw new IOException("Invalid Exp-Golomb code");
            }
            long suffix = 0;
            for (int i = 0; i < leading; i++) suffix = (suffix << 1) | readBit();
            long value = ((1L << leading) - 1L) + suffix;
            if (value > Integer.MAX_VALUE) throw new IOException("Exp-Golomb overflow");
            return (int) value;
        }
    }
}
