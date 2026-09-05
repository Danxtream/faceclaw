package androidx.media3.effect;

import android.content.Context;

import androidx.media3.common.C;
import androidx.media3.common.GlObjectsProvider;
import androidx.media3.common.GlTextureInfo;
import androidx.media3.common.VideoFrameProcessingException;
import androidx.media3.common.util.UnstableApi;

/**
 * Media3 1.9.4-compatible frame limiter using an absolute target clock.
 *
 * <p>Media3 1.9.4's public FrameDropEffect measures each decision from the last selected source
 * timestamp. For NTSC-rate inputs such as 29.97 fps, targeting 10 fps therefore tends to keep
 * every third frame forever, producing about 9.99 fps and cumulative duration drift. Media3 1.10
 * changed Transformer frame limiting to advance an independent expected timestamp by exactly
 * 1,000,000 / targetFps microseconds for every accepted frame. This effect backports that selection
 * rule while keeping the rest of Faceclaw on Media3 1.9.4 / compileSdk 35.
 *
 * <p>The first source frame at or after each absolute target slot is accepted. Source presentation
 * timestamps are preserved; only frame selection changes. With a source rate at or above the target
 * rate, this keeps the output frame count aligned to the requested G2 playback rate without the
 * unbounded 29.97 -> 9.99-style drift.
 */
@UnstableApi
public final class FaceclawExactFrameDropEffect implements GlEffect {
    private final float targetFrameRate;

    public static FaceclawExactFrameDropEffect create(float targetFrameRate) {
        if (!(targetFrameRate > 0f)) {
            throw new IllegalArgumentException("targetFrameRate must be positive");
        }
        return new FaceclawExactFrameDropEffect(targetFrameRate);
    }

    private FaceclawExactFrameDropEffect(float targetFrameRate) {
        this.targetFrameRate = targetFrameRate;
    }

    @Override
    public GlShaderProgram toGlShaderProgram(Context context, boolean useHdr)
            throws VideoFrameProcessingException {
        return new ExactClockFrameDroppingShaderProgram(context, useHdr, targetFrameRate);
    }

    private static final class ExactClockFrameDroppingShaderProgram
            extends FrameCacheGlShaderProgram {
        private final long targetFrameDeltaUs;
        private long nextExpectedPresentationTimeUs;

        ExactClockFrameDroppingShaderProgram(
                Context context, boolean useHdr, float targetFrameRate)
                throws VideoFrameProcessingException {
            super(context, /* capacity= */ 1, useHdr);
            targetFrameDeltaUs = (long) (C.MICROS_PER_SECOND / targetFrameRate);
            if (targetFrameDeltaUs <= 0) {
                throw new IllegalArgumentException("Invalid target frame interval");
            }
            nextExpectedPresentationTimeUs = C.TIME_UNSET;
        }

        @Override
        public void queueInputFrame(
                GlObjectsProvider glObjectsProvider,
                GlTextureInfo inputTexture,
                long presentationTimeUs) {
            if (nextExpectedPresentationTimeUs == C.TIME_UNSET) {
                // Always keep the first frame, then anchor every later decision to an independent
                // exact target clock rather than to the timestamp of the frame we happened to keep.
                nextExpectedPresentationTimeUs = presentationTimeUs + targetFrameDeltaUs;
                super.queueInputFrame(glObjectsProvider, inputTexture, presentationTimeUs);
                return;
            }

            if (presentationTimeUs < nextExpectedPresentationTimeUs) {
                // Same drop rule used by Media3 1.10's Transformer video renderer: samples before
                // the next exact target slot are discarded. A dropped texture never enters our
                // output pool, so return it to the upstream producer immediately.
                getInputListener().onInputFrameProcessed(inputTexture);
                getInputListener().onReadyToAcceptInputFrame();
                return;
            }

            // Advance by exactly one requested frame interval for every accepted source frame.
            // Do not re-anchor to presentationTimeUs. That is what prevents fractional-rate drift.
            nextExpectedPresentationTimeUs += targetFrameDeltaUs;
            super.queueInputFrame(glObjectsProvider, inputTexture, presentationTimeUs);
        }

        @Override
        public void signalEndOfCurrentInputStream() {
            super.signalEndOfCurrentInputStream();
            resetClock();
        }

        @Override
        public void flush() {
            super.flush();
            resetClock();
        }

        private void resetClock() {
            nextExpectedPresentationTimeUs = C.TIME_UNSET;
        }
    }
}
