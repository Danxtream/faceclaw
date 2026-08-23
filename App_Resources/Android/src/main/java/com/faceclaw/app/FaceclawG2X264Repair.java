package com.faceclaw.app;

import com.arthenica.ffmpegkit.FFmpegKit;
import com.arthenica.ffmpegkit.FFmpegSession;
import com.arthenica.ffmpegkit.ReturnCode;

import java.io.File;
import java.util.Locale;

/**
 * Desktop-equivalent libx264 fallback for short G2 GOP repairs only.
 *
 * The normal full-source conversion remains on MediaCodec hardware. This helper mirrors the
 * G2_VIDEO_MERGED.ps.txt local repair command: seek to StartFrame/FPS in the original source,
 * encode exactly FrameCount frames at CRF 12, keep Baseline/CAVLC/single-slice GOP settings, and
 * tighten only the local VBV maxrate/bufsize until the repaired GOP passes the G2 audit.
 */
public final class FaceclawG2X264Repair {
    public static final int CRF = 12;
    public static final int NORMAL_MAXRATE_KBPS = 110;
    public static final int NORMAL_BUFSIZE_KBPS = 22;

    private FaceclawG2X264Repair() {}

    public static final class Execution {
        public final boolean success;
        public final boolean cancelled;
        public final int maxRateKbps;
        public final int bufferKbps;
        public final String detail;

        Execution(boolean success, boolean cancelled, int maxRateKbps, int bufferKbps,
                  String detail) {
            this.success = success;
            this.cancelled = cancelled;
            this.maxRateKbps = maxRateKbps;
            this.bufferKbps = bufferKbps;
            this.detail = detail;
        }
    }

    public static Execution encode(File source, File output, int fps, int startFrame,
                                   int frameCount, int maxRateKbps) {
        if (source == null || !source.isFile()) {
            throw new IllegalArgumentException("x264 repair source is missing");
        }
        if (output == null) throw new IllegalArgumentException("x264 repair output is missing");
        if (fps <= 0) throw new IllegalArgumentException("Invalid repair FPS " + fps);
        if (startFrame < 0) throw new IllegalArgumentException("Invalid repair start frame " + startFrame);
        if (frameCount <= 0) throw new IllegalArgumentException("Invalid repair frame count " + frameCount);
        if (maxRateKbps < FaceclawG2LocalRepair.MINIMUM_LOCAL_RATE_KBPS) {
            throw new IllegalArgumentException("Invalid local repair rate " + maxRateKbps + " kbps");
        }

        File parent = output.getParentFile();
        if (parent != null && !parent.isDirectory() && !parent.mkdirs()) {
            throw new IllegalStateException("Could not create x264 repair work directory");
        }
        if (output.exists() && !output.delete()) {
            throw new IllegalStateException("Could not remove previous x264 repair candidate");
        }

        int bufferKbps = Math.max(8, (int) Math.round(
                NORMAL_BUFSIZE_KBPS * maxRateKbps / (double) NORMAL_MAXRATE_KBPS));
        String startText = String.format(Locale.US, "%.6f", startFrame / (double) fps);
        String x264Params = "cabac=0"
                + ":ref=1"
                + ":bframes=0"
                + ":weightp=0"
                + ":keyint=128"
                + ":min-keyint=65"
                + ":scenecut=0"
                + ":slices=1"
                + ":aq-mode=2"
                + ":aq-strength=1.0"
                + ":ipratio=0.50"
                + ":vbv-maxrate=" + maxRateKbps
                + ":vbv-bufsize=" + bufferKbps
                + ":repeat-headers=1"
                + ":annexb=1"
                + ":stitchable=1";

        String[] args = new String[] {
                "-hide_banner",
                "-y",
                "-loglevel", "error",
                "-ss", startText,
                "-i", source.getAbsolutePath(),
                "-map", "0:v:0",
                "-vf", "fps=" + fps + ",scale="
                        + FaceclawG2VideoBitstream.WIDTH + ":"
                        + FaceclawG2VideoBitstream.HEIGHT
                        + ":flags=lanczos+accurate_rnd+full_chroma_int",
                "-frames:v", Integer.toString(frameCount),
                "-an",
                "-c:v", "libx264",
                "-preset", "slow",
                "-crf", Integer.toString(CRF),
                "-pix_fmt", "yuv420p",
                "-profile:v", "baseline",
                "-level:v", "3.0",
                "-threads", "0",
                "-x264-params", x264Params,
                "-f", "h264",
                output.getAbsolutePath()
        };

        FFmpegSession session = FFmpegKit.executeWithArguments(args);
        boolean success = ReturnCode.isSuccess(session.getReturnCode());
        boolean cancelled = ReturnCode.isCancel(session.getReturnCode());
        String detail = session.getOutput();
        if (detail == null || detail.trim().isEmpty()) detail = session.getFailStackTrace();
        if (detail == null) detail = "";
        detail = compact(detail);

        if (!success && output.exists()) output.delete();
        return new Execution(success, cancelled, maxRateKbps, bufferKbps, detail);
    }

    public static void cancelAll() {
        try {
            FFmpegKit.cancel();
        } catch (Throwable ignored) {}
    }

    private static String compact(String text) {
        String value = text.replace('\r', ' ').replace('\n', ' ').trim();
        while (value.contains("  ")) value = value.replace("  ", " ");
        if (value.length() > 600) value = value.substring(value.length() - 600);
        return value;
    }
}
