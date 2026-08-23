package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;

import androidx.annotation.Nullable;
import androidx.core.content.ContextCompat;
import androidx.media3.common.Effect;
import androidx.media3.common.MediaItem;
import androidx.media3.common.MimeTypes;
import androidx.media3.common.audio.AudioProcessor;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.effect.Presentation;
import androidx.media3.transformer.Composition;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;

import com.tns.NativeScriptActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

@UnstableApi
public class FaceclawVideoConversionService extends Service {
    public static final String ACTION_START = "com.faceclaw.app.action.VIDEO_CONVERT_START";
    public static final String ACTION_CANCEL = "com.faceclaw.app.action.VIDEO_CONVERT_CANCEL";
    public static final String EXTRA_INPUT = "input";
    public static final String EXTRA_FPS = "fps";

    private static final String CHANNEL_ID = "faceclaw-video-conversion";
    private static final int NOTIFICATION_ID = 4202;
    private static final int VIDEO_BITRATE = 90_000;
    // Desktop repair estimates are based on its 110k normal VBV ceiling, not the hardware
    // encoder's average bitrate. Keep the full movie at 90 kbps MediaCodec, but calculate x264
    // repair caps from the desktop reference value.
    private static final int NORMAL_RATE_KBPS = FaceclawG2X264Repair.NORMAL_MAXRATE_KBPS;
    private static final int PROGRESS_INTERVAL_MS = 500;
    private static final Object STATE_LOCK = new Object();
    private static String stateJson = "{\"running\":false,\"stage\":\"idle\",\"progress\":0}";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<Integer, Integer> repairRates = new HashMap<>();

    private Transformer transformer;
    private FaceclawG2EncoderFactory encoderFactory;
    private ProgressHolder progressHolder;
    private Runnable progressPoll;

    private File inputFile;
    private File workDir;
    private File workMp4;
    private File segmentsDir;
    private File repairRaw;
    private File candidateH264;
    private File finalH264;
    private File metadataFile;

    private FaceclawG2LocalRepair.Plan repairPlan;
    private List<Integer> repairQueue = new ArrayList<>();
    private int repairQueuePosition;
    private int repairRound;
    private int repairTry;
    private int repairStartRateKbps;
    private int repairedSegments;
    private FaceclawG2LocalRepair.Segment currentRepairSegment;

    private int fps;
    private long startedAtMs;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean cancelled;
    private volatile boolean x264RepairActive;

    public static void start(Context context, String inputPath, int fps) {
        Intent intent = new Intent(context, FaceclawVideoConversionService.class);
        intent.setAction(ACTION_START);
        intent.putExtra(EXTRA_INPUT, inputPath);
        intent.putExtra(EXTRA_FPS, fps);
        ContextCompat.startForegroundService(context, intent);
    }

    public static void cancel(Context context) {
        Intent intent = new Intent(context, FaceclawVideoConversionService.class);
        intent.setAction(ACTION_CANCEL);
        context.startService(intent);
    }

    public static String snapshotJson() {
        synchronized (STATE_LOCK) {
            return stateJson;
        }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String action = intent != null ? intent.getAction() : null;
        if (ACTION_CANCEL.equals(action)) {
            cancelCurrent("Cancelled");
            return START_NOT_STICKY;
        }
        if (!ACTION_START.equals(action)) return START_NOT_STICKY;
        synchronized (STATE_LOCK) {
            try {
                if (new JSONObject(stateJson).optBoolean("running", false)) {
                    return START_NOT_STICKY;
                }
            } catch (Exception ignored) {}
        }
        begin(intent.getStringExtra(EXTRA_INPUT), intent.getIntExtra(EXTRA_FPS, 10));
        return START_NOT_STICKY;
    }

    private void begin(String inputPath, int requestedFps) {
        ensureChannel();
        startAsForeground(buildNotification("Preparing video", 0, true));
        try {
            if (inputPath == null || !inputPath.toLowerCase(Locale.US).endsWith(".mp4")) {
                throw new IllegalArgumentException("Input must be an MP4 file");
            }
            if (!supportedFps(requestedFps)) {
                throw new IllegalArgumentException("Unsupported FPS: " + requestedFps);
            }
            inputFile = new File(inputPath);
            if (!inputFile.isFile()) {
                throw new IllegalArgumentException("MP4 not found: " + inputPath);
            }
            fps = requestedFps;

            double sourceFps = probeSourceFps(inputFile);
            if (sourceFps > 0 && sourceFps + 0.25 < fps) {
                throw new IllegalArgumentException(String.format(Locale.US,
                        "Source is about %.2f FPS. Choose %d FPS or lower.",
                        sourceFps, largestChoiceAtOrBelow(sourceFps)));
            }

            String base = inputFile.getName().replaceFirst("(?i)\\.mp4$", "");
            File parent = inputFile.getParentFile();
            if (parent == null) {
                throw new IllegalArgumentException("Input has no parent directory");
            }
            finalH264 = new File(parent, base + ".h264");
            metadataFile = new File(parent, base + ".g2.json");
            candidateH264 = new File(parent, "." + base + ".h264.part");
            if (finalH264.exists()) {
                throw new IllegalStateException("Output already exists: " + finalH264.getName());
            }

            File external = getExternalFilesDir(null);
            if (external == null) {
                throw new IllegalStateException("External app storage unavailable");
            }
            File root = new File(external, "video-convert");
            workDir = new File(root, base);
            FaceclawG2LocalRepair.deleteTree(workDir);
            if (!workDir.isDirectory() && !workDir.mkdirs()) {
                throw new IllegalStateException("Could not create conversion work directory");
            }
            workMp4 = new File(workDir, "full.work.mp4");
            segmentsDir = new File(workDir, "segments");
            deleteQuietly(candidateH264);
            deleteQuietly(metadataFile);

            repairPlan = null;
            repairQueue.clear();
            repairRates.clear();
            repairQueuePosition = 0;
            repairRound = 0;
            repairTry = 0;
            repairedSegments = 0;
            currentRepairSegment = null;
            cancelled = false;
            x264RepairActive = false;
            startedAtMs = System.currentTimeMillis();
            acquireWakeLock();
            publish("encoding", 0, true, "G2 Baseline hardware encoding", null);
            startFullTransformer();
        } catch (Throwable error) {
            fail(errorMessage(error));
        }
    }

    private void startFullTransformer() {
        encoderFactory = new FaceclawG2EncoderFactory(
                this,
                VIDEO_BITRATE,
                fps,
                128f / fps);
        EditedMediaItem item = buildEditedItem(MediaItem.fromUri(Uri.fromFile(inputFile)));
        transformer = buildTransformer(item, new Transformer.Listener() {
            @Override
            public void onCompleted(Composition composition, ExportResult exportResult) {
                stopProgressPolling();
                if (cancelled) return;
                publish("auditing", 88, true, "Auditing full G2 encode", null);
                worker.execute(FaceclawVideoConversionService.this::finishFullEncode);
            }

            @Override
            public void onError(Composition composition, ExportResult exportResult,
                                ExportException error) {
                stopProgressPolling();
                if (!cancelled) {
                    fail("G2 conversion failed: " + errorMessage(error));
                }
            }
        });
        transformer.start(item, workMp4.getAbsolutePath());
        startFullProgressPolling();
    }

    private Transformer buildTransformer(EditedMediaItem item, Transformer.Listener listener) {
        return new Transformer.Builder(this)
                .setEncoderFactory(encoderFactory)
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .addListener(listener)
                .build();
    }

    private EditedMediaItem buildEditedItem(MediaItem mediaItem) {
        Effect presentation = Presentation.createForWidthAndHeight(
                FaceclawG2VideoBitstream.WIDTH,
                FaceclawG2VideoBitstream.HEIGHT,
                Presentation.LAYOUT_STRETCH_TO_FIT);
        Effects effects = new Effects(
                Collections.<AudioProcessor>emptyList(),
                Collections.singletonList(presentation));
        return new EditedMediaItem.Builder(mediaItem)
                .setRemoveAudio(true)
                .setFrameRate(fps)
                .setEffects(effects)
                .build();
    }

    private void finishFullEncode() {
        try {
            if (cancelled) return;

            FaceclawG2VideoBitstream.Result preflight =
                    FaceclawG2VideoBitstream.extractAndAudit(workMp4, candidateH264, fps);
            if (preflight.passed) {
                completeVerified(preflight);
                return;
            }
            if (!isRepairableTransportFailure(preflight)) {
                throw new IllegalStateException(preflight.failure);
            }

            publish("repairing", 89, true,
                    "Mapping failing GOPs for x264 local repair", null);
            repairPlan = FaceclawG2LocalRepair.extractInitialGops(
                    workMp4, segmentsDir, candidateH264, fps);
            FaceclawG2LocalRepair.Audit global =
                    FaceclawG2LocalRepair.auditAnnexB(candidateH264, fps);

            if (global.passesTransport()) {
                FaceclawG2VideoBitstream.Result result = FaceclawG2LocalRepair.toResult(
                        global, candidateH264, fps, repairPlan.durationUs);
                if (!result.passed) throw new IllegalStateException(result.failure);
                completeVerified(result);
                return;
            }

            List<Integer> affected = FaceclawG2LocalRepair.affectedSegments(repairPlan, global);
            if (affected.isEmpty()) {
                throw new IllegalStateException(
                        "G2 audit failed but no repairable GOP was identified: " + global.failure());
            }
            repairRound = 1;
            main.post(() -> beginRepairRound(affected, global));
        } catch (Throwable error) {
            postFail(errorMessage(error));
        }
    }

    private boolean isRepairableTransportFailure(FaceclawG2VideoBitstream.Result result) {
        // Transport gets repaired before final FPS-duration validation. Codec/frame contract failures
        // still stop immediately. The final assembled file goes through the FPS-sync gate again.
        if (result.frames <= 0 || result.profileIdc != 66 || result.cabac) return false;
        return result.transportOverCeiling > 0
                || result.worst1WritesPerSec > FaceclawG2VideoBitstream.MAX_1SEC_WRITES + 1e-6
                || result.worst5WritesPerSec > FaceclawG2VideoBitstream.MAX_5SEC_WRITES + 1e-6;
    }

    private void beginRepairRound(List<Integer> affected, FaceclawG2LocalRepair.Audit global) {
        if (cancelled) return;
        repairQueue = new ArrayList<>(affected);
        repairQueuePosition = 0;
        String message = String.format(Locale.US,
                "x264 local repair round %d: %d GOP(s), max NAL %d B",
                repairRound,
                repairQueue.size(),
                global.maxTransportNal);
        publish("repairing", repairProgress(), true, message, null);
        prepareNextRepairSegment();
    }

    private void prepareNextRepairSegment() {
        if (cancelled) return;
        if (repairQueuePosition >= repairQueue.size()) {
            worker.execute(this::finishRepairRound);
            return;
        }

        int segmentIndex = repairQueue.get(repairQueuePosition);
        if (repairPlan == null || segmentIndex < 0 || segmentIndex >= repairPlan.segments.size()) {
            postFail("Invalid local repair GOP index " + segmentIndex);
            return;
        }
        currentRepairSegment = repairPlan.segments.get(segmentIndex);
        worker.execute(() -> {
            try {
                FaceclawG2LocalRepair.Audit local =
                        FaceclawG2LocalRepair.auditAnnexB(currentRepairSegment.path, fps);
                Integer previousRate = repairRates.get(currentRepairSegment.index);
                repairStartRateKbps = FaceclawG2LocalRepair.firstRepairRateKbps(
                        local,
                        previousRate,
                        NORMAL_RATE_KBPS);
                repairTry = 1;
                main.post(this::startRepairAttempt);
            } catch (Throwable error) {
                postFail(errorMessage(error));
            }
        });
    }

    private void startRepairAttempt() {
        if (cancelled || currentRepairSegment == null) return;

        final int localRateKbps = FaceclawG2LocalRepair.retryRateKbps(
                repairStartRateKbps,
                repairTry);
        final int localBufferKbps = Math.max(
                8,
                (int) Math.round(
                        FaceclawG2X264Repair.NORMAL_BUFSIZE_KBPS
                                * localRateKbps
                                / (double) FaceclawG2X264Repair.NORMAL_MAXRATE_KBPS));

        repairRaw = new File(workDir, String.format(Locale.US,
                "x264_%05d_try_%02d_%dk_%dk.h264",
                currentRepairSegment.index,
                repairTry,
                localRateKbps,
                localBufferKbps));
        deleteQuietly(repairRaw);

        String message = String.format(Locale.US,
                "x264 repair GOP %d/%d, try %d: CRF 12, maxrate %dk, buf %dk",
                repairQueuePosition + 1,
                repairQueue.size(),
                repairTry,
                localRateKbps,
                localBufferKbps);
        publish("repairing", repairProgress(), true, message, null);

        worker.execute(() -> runX264RepairAttempt(localRateKbps));
    }

    private void runX264RepairAttempt(int localRateKbps) {
        try {
            if (cancelled || currentRepairSegment == null) return;
            x264RepairActive = true;
            FaceclawG2X264Repair.Execution execution = FaceclawG2X264Repair.encode(
                    inputFile,
                    repairRaw,
                    fps,
                    currentRepairSegment.startFrame,
                    currentRepairSegment.frameCount,
                    localRateKbps);
            x264RepairActive = false;

            if (cancelled) {
                deleteQuietly(repairRaw);
                FaceclawG2LocalRepair.deleteTree(workDir);
                return;
            }
            if (!execution.success) {
                String detail = execution.detail == null || execution.detail.isEmpty()
                        ? "no FFmpeg diagnostic"
                        : execution.detail;
                throw new IllegalStateException(String.format(Locale.US,
                        "x264 GOP %d encode failed at %dk/%dk: %s",
                        currentRepairSegment.index,
                        execution.maxRateKbps,
                        execution.bufferKbps,
                        detail));
            }

            verifyRepairAttempt(localRateKbps);
        } catch (Throwable error) {
            x264RepairActive = false;
            if (!cancelled) postFail(errorMessage(error));
        } finally {
            x264RepairActive = false;
        }
    }

    private void verifyRepairAttempt(int localRateKbps) {
        try {
            if (cancelled) return;
            FaceclawG2LocalRepair.Audit local =
                    FaceclawG2LocalRepair.auditAnnexB(repairRaw, fps);
            boolean exactFrames = local.frames == currentRepairSegment.frameCount;
            boolean oneIdr = local.idrFrames == 1;

            if (local.passesTransport() && exactFrames && oneIdr) {
                FaceclawG2LocalRepair.replaceSegment(repairRaw, currentRepairSegment);
                repairRates.put(currentRepairSegment.index, localRateKbps);
                repairedSegments++;
                deleteQuietly(repairRaw);
                repairQueuePosition++;
                main.post(this::prepareNextRepairSegment);
                return;
            }

            String reason;
            if (!exactFrames) {
                reason = "repair frame count " + local.frames
                        + " != " + currentRepairSegment.frameCount;
            } else if (!oneIdr) {
                reason = "repair produced " + local.idrFrames + " IDRs; expected 1";
            } else {
                reason = local.failure() != null ? local.failure() : "local G2 transport audit failed";
            }

            deleteQuietly(repairRaw);

            // Match the desktop loop: once the local VBV floor is reached and still fails, stop.
            if (localRateKbps <= FaceclawG2LocalRepair.MINIMUM_LOCAL_RATE_KBPS) {
                throw new IllegalStateException(String.format(Locale.US,
                        "GOP %d still fails at x264 local maxrate %dk: %s",
                        currentRepairSegment.index,
                        FaceclawG2LocalRepair.MINIMUM_LOCAL_RATE_KBPS,
                        reason));
            }
            if (repairTry >= FaceclawG2LocalRepair.MAX_LOCAL_TRIES) {
                throw new IllegalStateException(String.format(Locale.US,
                        "GOP %d exhausted %d x264 local repair tries: %s",
                        currentRepairSegment.index,
                        FaceclawG2LocalRepair.MAX_LOCAL_TRIES,
                        reason));
            }

            repairTry++;
            main.post(this::startRepairAttempt);
        } catch (Throwable error) {
            postFail(errorMessage(error));
        }
    }

    private void finishRepairRound() {
        try {
            if (cancelled) return;
            publish("auditing", 96, true,
                    "Reassembling and auditing x264-repaired G2 stream", null);
            FaceclawG2LocalRepair.assemble(repairPlan, candidateH264);
            FaceclawG2LocalRepair.Audit global =
                    FaceclawG2LocalRepair.auditAnnexB(candidateH264, fps);

            if (global.passesTransport()) {
                FaceclawG2VideoBitstream.Result result = FaceclawG2LocalRepair.toResult(
                        global,
                        candidateH264,
                        fps,
                        repairPlan.durationUs);
                if (!result.passed) throw new IllegalStateException(result.failure);
                completeVerified(result);
                return;
            }

            if (repairRound >= FaceclawG2LocalRepair.MAX_GLOBAL_ROUNDS) {
                throw new IllegalStateException(
                        "Video still fails after maximum local repair rounds: " + global.failure());
            }
            List<Integer> affected = FaceclawG2LocalRepair.affectedSegments(repairPlan, global);
            if (affected.isEmpty()) {
                throw new IllegalStateException(
                        "Global G2 audit still fails but no affected GOP could be mapped: "
                                + global.failure());
            }
            repairRound++;
            main.post(() -> beginRepairRound(affected, global));
        } catch (Throwable error) {
            postFail(errorMessage(error));
        }
    }

    private int repairProgress() {
        if (repairQueue.isEmpty()) return 90;
        double within = repairQueuePosition / (double) repairQueue.size();
        double rounds = Math.min(
                1.0,
                ((repairRound - 1) + within) / FaceclawG2LocalRepair.MAX_GLOBAL_ROUNDS);
        return 90 + (int) Math.floor(rounds * 6.0);
    }

    private void completeVerified(FaceclawG2VideoBitstream.Result result) throws Exception {
        if (cancelled) return;
        publish("finalizing", 97, true, "Finalizing verified G2 stream", null);

        writeMetadata(result);
        if (finalH264.exists()) {
            throw new IllegalStateException(
                    "Output appeared while conversion was running: " + finalH264.getName());
        }
        if (!candidateH264.renameTo(finalH264)) {
            throw new IllegalStateException("Could not promote verified .h264 output");
        }
        FaceclawG2LocalRepair.deleteTree(workDir);

        long elapsed = Math.max(1, System.currentTimeMillis() - startedAtMs);
        double speed = (result.durationUs / 1_000_000.0) / (elapsed / 1000.0);
        String message = String.format(Locale.US,
                "%s ready - %.2fx realtime - %.2f fps - %d x264 local repair(s)",
                finalH264.getName(),
                speed,
                result.actualFps,
                repairedSegments);
        publish("complete", 100, false, message, null);
        notifyFinished("Video converted", message);
        cleanupAndStop(false);
    }

    private void writeMetadata(FaceclawG2VideoBitstream.Result result) throws Exception {
        JSONObject json = new JSONObject();
        json.put("version", 3);
        json.put("fps", fps);
        json.put("width", FaceclawG2VideoBitstream.WIDTH);
        json.put("height", FaceclawG2VideoBitstream.HEIGHT);
        json.put("backend", "android-mediacodec-baseline+x264-local-vbv-repair");
        json.put("encoderName", encoderFactory != null
                ? encoderFactory.getSelectedEncoderName() : "");
        json.put("bitrate", VIDEO_BITRATE);
        json.put("repairBackend", "libx264");
        json.put("repairCrf", FaceclawG2X264Repair.CRF);
        json.put("repairNormalMaxRateKbps", FaceclawG2X264Repair.NORMAL_MAXRATE_KBPS);
        json.put("repairNormalBufferKbps", FaceclawG2X264Repair.NORMAL_BUFSIZE_KBPS);
        json.put("repairRounds", repairRound);
        json.put("repairedSegments", repairedSegments);
        json.put("minimumRepairRateKbps", FaceclawG2LocalRepair.MINIMUM_LOCAL_RATE_KBPS);
        json.put("frames", result.frames);
        json.put("idrFrames", result.idrFrames);
        json.put("actualFps", result.actualFps);
        json.put("durationDriftMs", result.durationDriftMs);
        json.put("profileIdc", result.profileIdc);
        json.put("cabac", result.cabac);
        json.put("maxTransportNal", result.maxTransportNal);
        json.put("worst1WritesPerSec", result.worst1WritesPerSec);
        json.put("worst5WritesPerSec", result.worst5WritesPerSec);
        json.put("durationUs", result.durationUs);
        json.put("g2AuditPassed", true);
        try (FileOutputStream out = new FileOutputStream(metadataFile)) {
            out.write(json.toString(2).getBytes(StandardCharsets.UTF_8));
        }
    }

    private void startFullProgressPolling() {
        progressHolder = new ProgressHolder();
        progressPoll = new Runnable() {
            @Override
            public void run() {
                Transformer active = transformer;
                if (active == null || cancelled) return;
                if (active.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
                    int p = Math.max(
                            0,
                            Math.min(87, Math.round(progressHolder.progress * 0.87f)));
                    publish("encoding", p, true,
                            "G2 Baseline hardware encoding " + progressHolder.progress + "%",
                            null);
                }
                main.postDelayed(this, PROGRESS_INTERVAL_MS);
            }
        };
        main.post(progressPoll);
    }

    private static double probeSourceFps(File source) {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(source.getAbsolutePath());
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/")
                        && f.containsKey(MediaFormat.KEY_FRAME_RATE)) {
                    return f.getInteger(MediaFormat.KEY_FRAME_RATE);
                }
            }
        } catch (Throwable ignored) {
        } finally {
            try {
                extractor.release();
            } catch (Throwable ignored) {}
        }
        return 0;
    }

    private static boolean supportedFps(int value) {
        return value == 5 || value == 10 || value == 15
                || value == 20 || value == 25 || value == 30;
    }

    private static int largestChoiceAtOrBelow(double sourceFps) {
        int result = 5;
        for (int value : new int[] {5, 10, 15, 20, 25, 30}) {
            if (value <= sourceFps + 0.25) result = value;
        }
        return result;
    }

    private void cancelCurrent(String reason) {
        cancelled = true;
        stopProgressPolling();

        Transformer active = transformer;
        transformer = null;
        if (active != null) {
            try {
                active.cancel();
            } catch (Throwable ignored) {}
        }

        boolean repairWasActive = x264RepairActive;
        if (repairWasActive) FaceclawG2X264Repair.cancelAll();

        deleteQuietly(candidateH264);
        if (!repairWasActive) FaceclawG2LocalRepair.deleteTree(workDir);
        publish("cancelled", 0, false, reason, null);
        cleanupAndStop(true);
    }

    private void fail(String message) {
        cancelled = true;
        stopProgressPolling();

        Transformer active = transformer;
        transformer = null;
        if (active != null) {
            try {
                active.cancel();
            } catch (Throwable ignored) {}
        }

        boolean repairWasActive = x264RepairActive;
        if (repairWasActive) FaceclawG2X264Repair.cancelAll();

        deleteQuietly(candidateH264);
        if (!repairWasActive) FaceclawG2LocalRepair.deleteTree(workDir);
        publish("failed", 0, false, message, message);
        notifyFinished("Video conversion failed", message);
        cleanupAndStop(false);
    }

    private void postFail(String message) {
        main.post(() -> {
            if (!cancelled) fail(message);
        });
    }

    private void stopProgressPolling() {
        if (progressPoll != null) main.removeCallbacks(progressPoll);
        progressPoll = null;
    }

    private void publish(String stage, int progress, boolean running,
                         String message, String error) {
        try {
            JSONObject json = new JSONObject();
            json.put("running", running);
            json.put("stage", stage);
            json.put("progress", progress);
            json.put("fps", fps);
            json.put("inputPath", inputFile != null
                    ? inputFile.getAbsolutePath() : JSONObject.NULL);
            json.put("outputPath", finalH264 != null
                    ? finalH264.getAbsolutePath() : JSONObject.NULL);
            json.put("encoderName", encoderFactory != null
                    ? encoderFactory.getSelectedEncoderName() : "");
            json.put("repairBackend", repairedSegments > 0 || repairRound > 0
                    ? "libx264" : "");
            json.put("repairRound", repairRound);
            json.put("repairTry", repairTry);
            json.put("repairedSegments", repairedSegments);
            json.put("message", message != null ? message : "");
            if (error != null) json.put("error", error);
            synchronized (STATE_LOCK) {
                stateJson = json.toString();
            }
        } catch (Exception ignored) {}
        if (running) updateNotification(message, progress);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "Faceclaw video conversion",
                NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Progress for long MP4 to G2 video conversions.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text, int progress, boolean ongoing) {
        Intent launch = new Intent(this, NativeScriptActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent content = PendingIntent.getActivity(this, 20, launch, flags);
        Intent cancel = new Intent(this, FaceclawVideoConversionService.class)
                .setAction(ACTION_CANCEL);
        PendingIntent cancelPending = PendingIntent.getService(this, 21, cancel, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        builder.setContentTitle("Faceclaw video converter")
                .setContentText(text)
                .setSmallIcon(getApplicationInfo().icon)
                .setContentIntent(content)
                .setOnlyAlertOnce(true)
                .setOngoing(ongoing)
                .setProgress(100, Math.max(0, Math.min(100, progress)), false);
        if (ongoing) builder.addAction(0, "Cancel", cancelPending);
        return builder.build();
    }

    private void startAsForeground(Notification notification) {
        if (Build.VERSION.SDK_INT >= 35) {
            startForeground(
                    NOTIFICATION_ID,
                    notification,
                    ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
    }

    private void updateNotification(String text, int progress) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, buildNotification(text, progress, true));
        }
    }

    private void notifyFinished(String title, String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        manager.notify(
                NOTIFICATION_ID,
                builder.setContentTitle(title)
                        .setContentText(text)
                        .setSmallIcon(getApplicationInfo().icon)
                        .setOnlyAlertOnce(false)
                        .setOngoing(false)
                        .build());
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "faceclaw:video-convert");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void cleanupAndStop(boolean removeNotification) {
        releaseWakeLock();
        transformer = null;
        encoderFactory = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            stopForeground(removeNotification
                    ? STOP_FOREGROUND_REMOVE
                    : STOP_FOREGROUND_DETACH);
        } else {
            stopForeground(removeNotification);
        }
        stopSelf();
    }

    private void releaseWakeLock() {
        if (wakeLock != null) {
            try {
                if (wakeLock.isHeld()) wakeLock.release();
            } catch (Throwable ignored) {}
            wakeLock = null;
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) {
            try {
                file.delete();
            } catch (Throwable ignored) {}
        }
    }

    private static String errorMessage(Throwable error) {
        if (error == null) return "Unknown error";
        String message = error.getMessage();
        return message != null && !message.trim().isEmpty()
                ? message
                : error.getClass().getSimpleName();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        cancelCurrent("Android media-processing time limit reached; conversion stopped safely");
    }

    @Override
    public void onDestroy() {
        stopProgressPolling();
        if (x264RepairActive) FaceclawG2X264Repair.cancelAll();
        releaseWakeLock();
        worker.shutdownNow();
        super.onDestroy();
    }
}
