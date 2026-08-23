package com.faceclaw.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.media.MediaCodecInfo;
import android.media.MediaExtractor;
import android.media.MediaFormat;
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
import androidx.media3.transformer.DefaultEncoderFactory;
import androidx.media3.transformer.EditedMediaItem;
import androidx.media3.transformer.Effects;
import androidx.media3.transformer.ExportException;
import androidx.media3.transformer.ExportResult;
import androidx.media3.transformer.ProgressHolder;
import androidx.media3.transformer.Transformer;
import androidx.media3.transformer.VideoEncoderSettings;

import com.tns.NativeScriptActivity;

import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;
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
    private static final int PROGRESS_INTERVAL_MS = 500;
    private static final Object STATE_LOCK = new Object();
    private static String stateJson = "{\"running\":false,\"stage\":\"idle\",\"progress\":0}";

    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private Transformer transformer;
    private ProgressHolder progressHolder;
    private Runnable progressPoll;
    private File inputFile;
    private File workMp4;
    private File candidateH264;
    private File finalH264;
    private File metadataFile;
    private int fps;
    private long startedAtMs;
    private PowerManager.WakeLock wakeLock;
    private volatile boolean cancelled;

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
        synchronized (STATE_LOCK) { return stateJson; }
    }

    @Nullable
    @Override
    public IBinder onBind(Intent intent) { return null; }

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
                if (new JSONObject(stateJson).optBoolean("running", false)) return START_NOT_STICKY;
            } catch (Exception ignored) {}
        }
        begin(intent.getStringExtra(EXTRA_INPUT), intent.getIntExtra(EXTRA_FPS, 10));
        return START_NOT_STICKY;
    }

    private void begin(String inputPath, int requestedFps) {
        ensureChannel();
        startAsForeground(buildNotification("Preparing video", 0, true));
        try {
            if (inputPath == null || !inputPath.toLowerCase(Locale.US).endsWith(".mp4"))
                throw new IllegalArgumentException("Input must be an MP4 file");
            if (!supportedFps(requestedFps)) throw new IllegalArgumentException("Unsupported FPS: " + requestedFps);
            inputFile = new File(inputPath);
            if (!inputFile.isFile()) throw new IllegalArgumentException("MP4 not found: " + inputPath);
            fps = requestedFps;

            double sourceFps = probeSourceFps(inputFile);
            if (sourceFps > 0 && sourceFps + 0.25 < fps) {
                throw new IllegalArgumentException(String.format(Locale.US,
                        "Source is about %.2f FPS. Choose %d FPS or lower.", sourceFps, largestChoiceAtOrBelow(sourceFps)));
            }

            String base = inputFile.getName().replaceFirst("(?i)\\.mp4$", "");
            File parent = inputFile.getParentFile();
            if (parent == null) throw new IllegalArgumentException("Input has no parent directory");
            finalH264 = new File(parent, base + ".h264");
            metadataFile = new File(parent, base + ".g2.json");
            candidateH264 = new File(parent, "." + base + ".h264.part");
            if (finalH264.exists()) throw new IllegalStateException("Output already exists: " + finalH264.getName());

            File external = getExternalFilesDir(null);
            if (external == null) throw new IllegalStateException("External app storage unavailable");
            File workDir = new File(external, "video-convert");
            if (!workDir.isDirectory() && !workDir.mkdirs()) throw new IllegalStateException("Could not create conversion work directory");
            workMp4 = new File(workDir, base + ".work.mp4");
            deleteQuietly(workMp4);
            deleteQuietly(candidateH264);
            cancelled = false;
            startedAtMs = System.currentTimeMillis();
            acquireWakeLock();
            publish("encoding", 0, true, "Hardware encoding", null);
            startTransformer();
        } catch (Throwable error) {
            fail(errorMessage(error));
        }
    }

    private void startTransformer() {
        VideoEncoderSettings settings = new VideoEncoderSettings.Builder()
                .setBitrate(VIDEO_BITRATE)
                .setBitrateMode(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR)
                .setMaxBFrames(0)
                .setiFrameIntervalSeconds(128f / fps)
                .build();
        DefaultEncoderFactory encoderFactory = new DefaultEncoderFactory.Builder(this)
                .setRequestedVideoEncoderSettings(settings)
                .setEnableFallback(false)
                .build();
        Effect presentation = Presentation.createForWidthAndHeight(
                FaceclawG2VideoBitstream.WIDTH,
                FaceclawG2VideoBitstream.HEIGHT,
                Presentation.LAYOUT_STRETCH_TO_FIT);
        Effects effects = new Effects(Collections.<AudioProcessor>emptyList(), Collections.singletonList(presentation));
        EditedMediaItem item = new EditedMediaItem.Builder(MediaItem.fromUri(android.net.Uri.fromFile(inputFile)))
                .setRemoveAudio(true)
                .setFrameRate(fps)
                .setEffects(effects)
                .build();

        transformer = new Transformer.Builder(this)
                .setEncoderFactory(encoderFactory)
                .setVideoMimeType(MimeTypes.VIDEO_H264)
                .addListener(new Transformer.Listener() {
                    @Override
                    public void onCompleted(Composition composition, ExportResult exportResult) {
                        stopProgressPolling();
                        if (cancelled) return;
                        publish("auditing", 88, true, "Extracting and auditing G2 stream", null);
                        worker.execute(() -> finishBitstream());
                    }

                    @Override
                    public void onError(Composition composition, ExportResult exportResult, ExportException error) {
                        stopProgressPolling();
                        if (!cancelled) fail("Hardware conversion failed: " + errorMessage(error));
                    }
                }).build();

        transformer.start(item, workMp4.getAbsolutePath());
        progressHolder = new ProgressHolder();
        progressPoll = new Runnable() {
            @Override
            public void run() {
                Transformer active = transformer;
                if (active == null || cancelled) return;
                if (active.getProgress(progressHolder) == Transformer.PROGRESS_STATE_AVAILABLE) {
                    int p = Math.max(0, Math.min(87, Math.round(progressHolder.progress * 0.87f)));
                    publish("encoding", p, true, "Hardware encoding " + progressHolder.progress + "%", null);
                }
                main.postDelayed(this, PROGRESS_INTERVAL_MS);
            }
        };
        main.post(progressPoll);
    }

    private void finishBitstream() {
        try {
            if (cancelled) return;
            FaceclawG2VideoBitstream.Result result = FaceclawG2VideoBitstream.extractAndAudit(workMp4, candidateH264, fps);
            if (!result.passed) throw new IllegalStateException(result.failure);
            publish("finalizing", 97, true, "Finalizing verified G2 stream", null);

            // Metadata must exist before the H264 becomes visible to the player.
            writeMetadata(result);
            if (finalH264.exists()) throw new IllegalStateException("Output appeared while conversion was running: " + finalH264.getName());
            if (!candidateH264.renameTo(finalH264)) throw new IllegalStateException("Could not promote verified .h264 output");
            deleteQuietly(workMp4);

            long elapsed = Math.max(1, System.currentTimeMillis() - startedAtMs);
            double speed = (result.durationUs / 1_000_000.0) / (elapsed / 1000.0);
            String message = String.format(Locale.US, "%s ready - %.2fx realtime - %.2f fps", finalH264.getName(), speed, result.actualFps);
            publish("complete", 100, false, message, null);
            notifyFinished("Video converted", message);
            cleanupAndStop(false);
        } catch (Throwable error) {
            fail(errorMessage(error));
        }
    }

    private void writeMetadata(FaceclawG2VideoBitstream.Result result) throws Exception {
        JSONObject json = new JSONObject();
        json.put("version", 1);
        json.put("fps", fps);
        json.put("width", FaceclawG2VideoBitstream.WIDTH);
        json.put("height", FaceclawG2VideoBitstream.HEIGHT);
        json.put("backend", "android-mediacodec");
        json.put("bitrate", VIDEO_BITRATE);
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

    private static double probeSourceFps(File source) {
        MediaExtractor extractor = new MediaExtractor();
        try {
            extractor.setDataSource(source.getAbsolutePath());
            for (int i = 0; i < extractor.getTrackCount(); i++) {
                MediaFormat f = extractor.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("video/") && f.containsKey(MediaFormat.KEY_FRAME_RATE))
                    return f.getInteger(MediaFormat.KEY_FRAME_RATE);
            }
        } catch (Throwable ignored) {
        } finally {
            try { extractor.release(); } catch (Throwable ignored) {}
        }
        return 0;
    }

    private static boolean supportedFps(int value) {
        return value == 5 || value == 10 || value == 15 || value == 20 || value == 25 || value == 30;
    }

    private static int largestChoiceAtOrBelow(double sourceFps) {
        int result = 5;
        for (int value : new int[]{5, 10, 15, 20, 25, 30}) if (value <= sourceFps + 0.25) result = value;
        return result;
    }

    private void cancelCurrent(String reason) {
        cancelled = true;
        stopProgressPolling();
        Transformer active = transformer;
        transformer = null;
        if (active != null) try { active.cancel(); } catch (Throwable ignored) {}
        deleteQuietly(workMp4);
        deleteQuietly(candidateH264);
        publish("cancelled", 0, false, reason, null);
        cleanupAndStop(true);
    }

    private void fail(String message) {
        cancelled = true;
        stopProgressPolling();
        Transformer active = transformer;
        transformer = null;
        if (active != null) try { active.cancel(); } catch (Throwable ignored) {}
        deleteQuietly(workMp4);
        deleteQuietly(candidateH264);
        publish("failed", 0, false, message, message);
        notifyFinished("Video conversion failed", message);
        cleanupAndStop(false);
    }

    private void stopProgressPolling() {
        if (progressPoll != null) main.removeCallbacks(progressPoll);
        progressPoll = null;
    }

    private void publish(String stage, int progress, boolean running, String message, String error) {
        try {
            JSONObject json = new JSONObject();
            json.put("running", running);
            json.put("stage", stage);
            json.put("progress", progress);
            json.put("fps", fps);
            json.put("inputPath", inputFile != null ? inputFile.getAbsolutePath() : JSONObject.NULL);
            json.put("outputPath", finalH264 != null ? finalH264.getAbsolutePath() : JSONObject.NULL);
            json.put("message", message != null ? message : "");
            if (error != null) json.put("error", error);
            synchronized (STATE_LOCK) { stateJson = json.toString(); }
        } catch (Exception ignored) {}
        if (running) updateNotification(message, progress);
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Faceclaw video conversion", NotificationManager.IMPORTANCE_LOW);
        channel.setDescription("Progress for long MP4 to G2 video conversions.");
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(channel);
    }

    private Notification buildNotification(String text, int progress, boolean ongoing) {
        Intent launch = new Intent(this, NativeScriptActivity.class);
        launch.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) flags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent content = PendingIntent.getActivity(this, 20, launch, flags);
        Intent cancel = new Intent(this, FaceclawVideoConversionService.class).setAction(ACTION_CANCEL);
        PendingIntent cancelPending = PendingIntent.getService(this, 21, cancel, flags);
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
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
        // mediaProcessing is an API-35 service type. Do not pass its bit to old Android versions.
        if (Build.VERSION.SDK_INT >= 35)
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING);
        else
            startForeground(NOTIFICATION_ID, notification);
    }

    private void updateNotification(String text, int progress) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.notify(NOTIFICATION_ID, buildNotification(text, progress, true));
    }

    private void notifyFinished(String title, String text) {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) return;
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CHANNEL_ID) : new Notification.Builder(this);
        manager.notify(NOTIFICATION_ID, builder.setContentTitle(title).setContentText(text)
                .setSmallIcon(getApplicationInfo().icon).setOnlyAlertOnce(false).setOngoing(false).build());
    }

    private void acquireWakeLock() {
        PowerManager manager = (PowerManager) getSystemService(POWER_SERVICE);
        if (manager == null) return;
        wakeLock = manager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "faceclaw:video-convert");
        wakeLock.setReferenceCounted(false);
        wakeLock.acquire();
    }

    private void cleanupAndStop(boolean removeNotification) {
        releaseWakeLock();
        transformer = null;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N)
            stopForeground(removeNotification ? STOP_FOREGROUND_REMOVE : STOP_FOREGROUND_DETACH);
        else
            stopForeground(removeNotification);
        stopSelf();
    }

    private void releaseWakeLock() {
        if (wakeLock != null) {
            try { if (wakeLock.isHeld()) wakeLock.release(); } catch (Throwable ignored) {}
            wakeLock = null;
        }
    }

    private static void deleteQuietly(File file) {
        if (file != null && file.exists()) try { file.delete(); } catch (Throwable ignored) {}
    }

    private static String errorMessage(Throwable error) {
        if (error == null) return "Unknown error";
        String message = error.getMessage();
        return message != null && !message.trim().isEmpty() ? message : error.getClass().getSimpleName();
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        cancelCurrent("Android media-processing time limit reached; conversion stopped safely");
    }

    @Override
    public void onDestroy() {
        stopProgressPolling();
        releaseWakeLock();
        worker.shutdownNow();
        super.onDestroy();
    }
}
