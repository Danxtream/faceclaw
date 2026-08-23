package com.faceclaw.app;

import android.content.Context;
import android.media.MediaCodecInfo;
import android.media.MediaCodecList;
import android.media.MediaFormat;
import android.media.metrics.LogSessionId;
import android.os.Build;

import androidx.annotation.Nullable;
import androidx.media3.common.Format;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.transformer.Codec;
import androidx.media3.transformer.DefaultCodec;
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.ExportException;

import java.util.Locale;

/**
 * MediaCodec encoder factory for the G2 video contract.
 *
 * Media3 1.9.x DefaultEncoderFactory intentionally promotes H.264 to High profile on modern
 * Android versions. G2 requires Baseline/CAVLC, so this factory configures the actual MediaCodec
 * directly instead of allowing Media3 to rewrite the profile.
 */
@UnstableApi
public final class FaceclawG2EncoderFactory implements Codec.EncoderFactory {
    private final Context context;
    private final int bitrate;
    private final int fps;
    private final float iFrameIntervalSeconds;
    private final DefaultEncoderFactory audioDelegate;
    private volatile String selectedEncoderName = "";

    public FaceclawG2EncoderFactory(Context context, int bitrate, int fps, float iFrameIntervalSeconds) {
        this.context = context.getApplicationContext();
        this.bitrate = bitrate;
        this.fps = fps;
        this.iFrameIntervalSeconds = iFrameIntervalSeconds;
        this.audioDelegate = new DefaultEncoderFactory.Builder(this.context).build();
    }

    public String getSelectedEncoderName() {
        return selectedEncoderName;
    }

    @Override
    public Codec createForAudioEncoding(Format format, @Nullable LogSessionId logSessionId)
            throws ExportException {
        return audioDelegate.createForAudioEncoding(format, logSessionId);
    }

    @Override
    public Codec createForVideoEncoding(Format format, @Nullable LogSessionId logSessionId)
            throws ExportException {
        if (!MimeTypes.VIDEO_H264.equals(format.sampleMimeType)) {
            throw unsupported(format, null, "G2 converter requires H.264/AVC output");
        }
        if (format.width <= 0 || format.height <= 0) {
            throw unsupported(format, null, "G2 converter received invalid output dimensions");
        }

        MediaCodecInfo encoder = findBaselineEncoder(format.width, format.height, fps);
        if (encoder == null) {
            throw unsupported(
                    format,
                    null,
                    "No Android H.264 encoder advertises Baseline level 3.0 + CBR for "
                            + format.width + "x" + format.height + " @ " + fps + " FPS");
        }
        selectedEncoderName = encoder.getName();

        Format configurationFormat = format.buildUpon()
                .setSampleMimeType(MimeTypes.VIDEO_H264)
                .setFrameRate(fps)
                .setAverageBitrate(bitrate)
                .build();

        MediaFormat mediaFormat = MediaFormat.createVideoFormat(
                MimeTypes.VIDEO_H264,
                configurationFormat.width,
                configurationFormat.height);
        mediaFormat.setInteger(MediaFormat.KEY_BIT_RATE, bitrate);
        mediaFormat.setInteger(
                MediaFormat.KEY_BITRATE_MODE,
                MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR);
        mediaFormat.setInteger(MediaFormat.KEY_FRAME_RATE, fps);
        mediaFormat.setInteger(
                MediaFormat.KEY_PROFILE,
                MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline);
        mediaFormat.setInteger(
                MediaFormat.KEY_LEVEL,
                MediaCodecInfo.CodecProfileLevel.AVCLevel3);
        mediaFormat.setInteger(
                MediaFormat.KEY_COLOR_FORMAT,
                MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface);

        if (Build.VERSION.SDK_INT >= 25) {
            mediaFormat.setFloat(MediaFormat.KEY_I_FRAME_INTERVAL, iFrameIntervalSeconds);
        } else {
            mediaFormat.setInteger(
                    MediaFormat.KEY_I_FRAME_INTERVAL,
                    Math.max(1, (int) Math.ceil(iFrameIntervalSeconds)));
        }

        if (Build.VERSION.SDK_INT >= 29) {
            mediaFormat.setInteger(MediaFormat.KEY_MAX_B_FRAMES, 0);
        }

        return new DefaultCodec(
                context,
                configurationFormat,
                mediaFormat,
                encoder.getName(),
                false,
                null);
    }

    @Override
    public boolean audioNeedsEncoding() {
        return audioDelegate.audioNeedsEncoding();
    }

    @Override
    public boolean videoNeedsEncoding() {
        return true;
    }

    private static MediaCodecInfo findBaselineEncoder(int width, int height, int fps) {
        MediaCodecInfo softwareCandidate = null;
        MediaCodecInfo[] infos = new MediaCodecList(MediaCodecList.ALL_CODECS).getCodecInfos();

        for (MediaCodecInfo info : infos) {
            if (!info.isEncoder() || !supportsAvc(info)) continue;

            MediaCodecInfo.CodecCapabilities caps;
            try {
                caps = info.getCapabilitiesForType(MimeTypes.VIDEO_H264);
            } catch (Throwable ignored) {
                continue;
            }

            if (!supportsBaselineLevel3(caps)) continue;

            MediaCodecInfo.EncoderCapabilities encoderCaps;
            try {
                encoderCaps = caps.getEncoderCapabilities();
            } catch (Throwable ignored) {
                continue;
            }
            if (encoderCaps == null
                    || !encoderCaps.isBitrateModeSupported(
                            MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)) {
                continue;
            }

            MediaCodecInfo.VideoCapabilities videoCaps;
            try {
                videoCaps = caps.getVideoCapabilities();
            } catch (Throwable ignored) {
                continue;
            }
            if (videoCaps == null || !videoCaps.isSizeSupported(width, height)) continue;
            try {
                if (!videoCaps.areSizeAndRateSupported(width, height, fps)) continue;
            } catch (Throwable ignored) {
                // Size support is the hard requirement. Some vendor capability queries are buggy.
            }

            if (!isSoftwareCodec(info)) return info;
            if (softwareCandidate == null) softwareCandidate = info;
        }

        // Keep a system software MediaCodec as a last resort. The strict post-encode G2 audit still
        // decides whether the result is usable.
        return softwareCandidate;
    }

    private static boolean supportsAvc(MediaCodecInfo info) {
        for (String type : info.getSupportedTypes()) {
            if (MimeTypes.VIDEO_H264.equalsIgnoreCase(type)) return true;
        }
        return false;
    }

    private static boolean supportsBaselineLevel3(MediaCodecInfo.CodecCapabilities caps) {
        if (caps.profileLevels == null) return false;
        for (MediaCodecInfo.CodecProfileLevel profileLevel : caps.profileLevels) {
            if (profileLevel.profile == MediaCodecInfo.CodecProfileLevel.AVCProfileBaseline
                    && profileLevel.level >= MediaCodecInfo.CodecProfileLevel.AVCLevel3) {
                return true;
            }
        }
        return false;
    }

    private static boolean isSoftwareCodec(MediaCodecInfo info) {
        if (Build.VERSION.SDK_INT >= 29) return info.isSoftwareOnly();
        String name = info.getName().toLowerCase(Locale.US);
        return name.startsWith("omx.google.")
                || name.startsWith("c2.android.")
                || name.contains(".sw.")
                || name.contains("software");
    }

    private static ExportException unsupported(Format format, @Nullable String codecName, String message) {
        return ExportException.createForCodec(
                new IllegalArgumentException(message),
                ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED,
                new ExportException.CodecInfo(format.toString(), true, false, codecName));
    }
}
