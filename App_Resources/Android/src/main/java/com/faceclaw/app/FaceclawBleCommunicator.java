package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.app.KeyguardManager;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import java.io.ByteArrayOutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

@SuppressLint("MissingPermission")
public class FaceclawBleCommunicator implements FaceclawBleListener, Runnable {
    private static final String TAG = "FaceclawComm";

    // The EvenHub image container is a memory carrier only. Its 576x288 geometry
    // gives the firmware separate 165888-byte display and reconstruction
    // allocations: CFW reuses the former for its 640x480 packed-4bpp shadow and
    // leaves the latter wholly available for compressed incoming messages.
    private static final BleProtocol.ImageTileOptions DASHBOARD_TILE =
        new BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288);

    private static final String G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen";
    private static final long FACECLAW_WAKE_LEASE_RENEW_MS = 45_000;
    private static final long FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500;

    private final Context appContext;
    private final PowerManager powerManager;
    private final KeyguardManager keyguardManager;
    private final FaceclawBleManager bleManager;
    private final InterruptibleSleep interruptibleSleep = new InterruptibleSleep();
    private final Object lock = new Object();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private final String rightAddress;
    private final String leftAddress;
    private final String ringAddress;

    private volatile FaceclawBleCommunicatorListener listener;
    private final java.util.List<FaceclawImuListener> imuListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private final java.util.List<FaceclawCompassListener> compassListeners =
        new java.util.concurrent.CopyOnWriteArrayList<>();
    private volatile Thread workerThread;
    private volatile boolean running;
    private volatile boolean userDisconnectRequested;

    private String phase = "disconnected";
    private String status = "Disconnected.";

    private boolean rightConnected;
    private boolean leftConnected;
    private boolean ringConnected;
    private boolean ringNotificationsReady;
    private boolean sessionReady;
    private boolean fixedLayoutCreated;
    private boolean warmedUp;
    private boolean shutdownRequested;
    // CFW firmware-debug-flags overlay (mode 7). Desired value pushed from TS; the
    // sub-op last sent this session (-1 = not yet), reset on (re)connect so the
    // overlay state is re-asserted on every reconnect and whenever the value changes.
    private volatile boolean firmwareDebugFlagsEnabled;
    private int firmwareDebugFlagsLastSent = -1;
    // Desired CFW mode-10 compass state. It survives reconnects; lastSent is
    // reset with each session so an open Compass window is re-asserted.
    private boolean compassEnabled;
    private int compassControlLastSent = -1;
    // Whether the glasses-side compass may still be running: set when an enable
    // is enqueued, cleared only when a disable is acked. Drives the forced
    // disable sent ahead of an EvenHub shutdown/suspend, since a pending
    // disable can be wiped by the shutdown's queue flush and the retry loop
    // does not run while shutdownRequested (magnetometer left on = battery drain).
    private boolean compassMaybeOn;
    private boolean startupProbePending;
    // Desired ownership of CFW's fail-open stock-wake lease (dashboard launch
    // and Even AI foreground takeover). This survives a transport reconnect;
    // the lease itself is volatile firmware state and is re-acquired once both
    // arms are ready.
    private boolean faceclawWakeLeaseEnabled;
    private long lastFaceclawWakeLeaseQueuedAtMs;
    private int faceclawWakeControlGeneration;
    private int faceclawWakeControlSentCount;
    private long lastFaceclawFramebufferLeaseQueuedAtMs;
    private int faceclawFramebufferControlGeneration;
    private int faceclawFramebufferControlSentCount;
    private int faceclawWakePendingNonce = -1;

    private long reconnectAfterMs;
    private long ringReconnectAfterMs;
    private long lastAckAtMs;
    private long lastIncomingAtMs;
    private long lastHeartbeatSentAtMs;
    private long lastHeartbeatAckedAtMs;
    private long lastConnectionOrInputAtMs;
    private long lastBatteryRefreshAtMs;
    private long imageRetryAfterMs;
    private long lastSessionReadyAtMs;
    private long lastEvenAppConflictAtMs;
    private int consecutiveAckTimeouts;
    private int lastAudioControlAckMagic = 0;

    // With serialized physical BLE delivery, keep four logical NALs prepared.
    // Three reduced throughput without improving presentation gaps or lens skew.
    private static final int H264_LOGICAL_WINDOW = 4;
    private static final int H264_BLE_WINDOW = 2;
    private static final boolean H264_SEND_TO_LEFT = true;
    private static final int H264_STARTUP_WINDOW = 1;
    private static final int H264_PAYLOAD_BUDGET_BYTES = 16 * 1024;
    // A V11 firmware snapshot is 4096 bytes. Keep one ordinary encoded NAL in a
    // single image message while leaving room for the mode-11 sequence header.
    private static final int H264_FRAGMENT_SIZE = 3800;
    private static final long H264_WAIT_TIMEOUT_MS = 30_000L;
    private static final long H264_ASYNC_TIMEOUT_MS = 5_000L;
    private static final long H264_DECODER_CONFIRM_MS = 1_200L;
    private static final int H264_MAX_RETRIES = 1;
    private static final int H264_RESULT_CACHE_SIZE = 64;

    /**
     * Completion state for one logical mode-11 payload.  This deliberately
     * outlives movement of its fragments between pending/writing/in-flight;
     * queue membership is not a reliable lifecycle signal while a BLE write
     * is being prepared.
     */
    private static final class H264Transfer {
        final int id;
        final byte[] payload;
        final int streamId;
        final int sequence;
        int fragmentCount;
        int acknowledgedFragments;
        int sentFragments;
        int wireGeneration;
        int retryCount;
        long confirmationDeadlineMs;
        boolean transportAcked;
        boolean decoderConfirmed;
        boolean leftDecoderConfirmed;
        boolean rightDecoderConfirmed;
        boolean retryPending;
        boolean recoveryInProgress;
        boolean terminal;
        boolean failed;

        H264Transfer(int id, byte[] payload, int streamId, int sequence) {
            this.id = id;
            this.payload = Arrays.copyOf(payload, payload.length);
            this.streamId = streamId;
            this.sequence = sequence;
        }
    }

    private final ArrayDeque<H264Transfer> h264Transfers = new ArrayDeque<>();
    private final Map<Integer, Integer> h264TransferResults = new HashMap<>();
    private final ArrayDeque<Integer> h264TransferResultOrder = new ArrayDeque<>();
    private int nextH264TransferId = 1;
    private boolean h264Streaming;
    private boolean h264StreamFailed;
    private boolean h264Ending;
    private int h264EndResult;
    private long h264EndDeadlineMs;
    private H264Transfer h264EndTransfer;
    private int h264StreamId;
    private int h264HighestQueuedSeq;
    private int h264DecodedSeq;
    private int h264PresentedSeq;
    private int h264RetryCount;
    private int h264MaxFirmwareQueueDepth;
    private int h264MaxOutstanding;
    private int h264MaxOutstandingBytes;
    private int h264FirmwareQueueCapacity;
    private int h264FirmwareQueuedBytes;
    private int h264FirmwareFrames;
    private int h264TelemetryVersion;
    private long h264FirstPresentationAtMs;
    private long h264LastPresentationAtMs;
    private long h264PresentationIntervals;
    private long h264MaxPresentationGapMs;
    private int h264LeftPresentedSeq;
    private int h264RightPresentedSeq;
    private long h264MaxLensSequenceSkew;
    private int h264LeftDecodedSeq;
    private int h264RightDecodedSeq;
    private int h264LeftQueueDepth;
    private int h264RightQueueDepth;
    private boolean h264LeftTelemetrySeen;
    private boolean h264RightTelemetrySeen;
    private boolean h264AdmissionPaused;
    private String h264AdmissionPauseReason = "";
    private long h264AdmissionPauseStartedAtMs;
    private long h264AdmissionPauseTotalMs;
    private long h264AdmissionPauseMaxMs;
    private int h264AdmissionPauseCount;
    private int h264FirmwareEmptyDeferredCallbacks;
    private int h264FirmwareBacklogDeferredCallbacks;
    private int h264FirmwarePaceScheduled;
    private int h264FirmwarePaceFired;
    private int h264FirmwarePaceDirect;
    private int h264FirmwarePaceLate;
    private int h264FirmwarePaceMaxLateMs;
    private long h264DisplayTimingSamples;
    private long h264DisplayGateWaitTotalUs;
    private long h264DisplayGateWaitMaxUs;
    private long h264DisplayPresentTotalUs;
    private long h264DisplayPresentMaxUs;

    private static final class H264Telemetry {
        int version;
        int side;
        int flags;
        int queueDepth;
        int nalType;
        int result;
        int streamId;
        int receivedSeq;
        int decodedSeq;
        int presentedSeq;
        int frames;
        int decodeUs;
        int expectedSeq;
        int queueCapacity;
        int queuedBytes;
        int diagStage;
        int diagMbEntered;
        int diagMbCompleted;
        int diagBitOffset;
        int emptyDeferredCallbacks;
        int backlogDeferredCallbacks;
        int paceScheduled;
        int paceFired;
        int paceDirect;
        int paceLate;
        int paceMaxLateMs;
        int displayGateWaitUs;
        int displayPresentUs;
    }

    private ConnectionOptions connectionOptions = new ConnectionOptions();
    private final BleMagicPool magicPool = new BleMagicPool();
    private MessageBuilder messageBuilder = new MessageBuilder(magicPool);
    private int nextTransportSeq = 0x40;
    private int nextMapSessionId = 0;
    private int nextImageUpdateId = 1;
    // Wire frame id for mode-3 deltas (CFW reorder/skip/dup diagnostic). uint16,
    // advanced by 1 per emitted delta; kept in [1, 0xfffe] to avoid the CFW's
    // 0xffff "empty" sentinel.
    private int nextImageFrameId = 1;
    private int lastShutdownAckMagic = 0;
    private long lastShutdownExitAtMs = 0;
    private int headsetBattery = -1;
    private int headsetCharging = -1;
    // Silent mode: 1 = on, 0 = off, -1 = not yet known. See updateSilentModeLocked.
    private int silentMode = -1;
    private int wearState = -1;
    private int phoneLockState = -1;
    private long lastPhoneLockCheckAtMs;
    private boolean phoneLockReceiverRegistered;
    private boolean audioCaptureActive;
    private boolean firmwareInfoQueried;
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    private boolean chargingMode;
    private volatile FaceclawAudioPacketListener audioPacketListener;
    private PowerManager.WakeLock g2ScreenWakeLock;

    private final BroadcastReceiver phoneLockReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context context, Intent intent) {
            emitPhoneLockStateIfChanged(true);
            interruptibleSleep.interrupt();
        }
    };

    private String displayedFingerprint = "";
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image (headerless packed 4bpp, see
    // BmpUtil.pack4bppFromGray8), which is the correct base for the next delta
    // when frames are pipelined. Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    private byte[] lastEnqueuedPacked = new byte[0];
    private int lastEnqueuedWidth;
    private int lastEnqueuedHeight;
    private String lastEnqueuedFingerprint = "";
    private final Map<Integer, BleImageOptimizer.ImageUpdateStats> imageUpdateStats = new HashMap<>();

    private final Object desiredTilesLock = new Object();
    private String desiredFingerprint = "";
    // Headerless packed 4bpp frame (see BmpUtil.pack4bppFromGray8) plus its
    // pixel dimensions.
    private byte[] desiredPacked = new byte[0];
    private int desiredWidth;
    private int desiredHeight;
    private int desiredPaintMs;
    private int desiredFrameId;
    // Highest compositor sequence stored as the desired frame; composites that
    // lost a store race to a newer one are discarded (their content is already
    // included in the newer composite).
    private long lastStoredCompositeSeq;

    private final SurfaceCompositor compositor = new SurfaceCompositor();

    private final ArrayDeque<OutboundMessage> pendingMessages = new ArrayDeque<>();
    private final ArrayDeque<OutboundMessage> inFlightMessages = new ArrayDeque<>();
    private OutboundMessage prewrittenMessage;
    private List<byte[]> prewrittenFrames = Collections.emptyList();

    public FaceclawBleCommunicator(Context context, String rightAddress, String leftAddress, String ringAddress) {
        this.appContext = context.getApplicationContext();
        FrameTimings.getInstance().init(appContext);
        this.powerManager = (PowerManager) appContext.getSystemService(Context.POWER_SERVICE);
        this.keyguardManager = (KeyguardManager) appContext.getSystemService(Context.KEYGUARD_SERVICE);
        this.bleManager = new FaceclawBleManager(appContext);
        this.bleManager.setListener(this);
        this.rightAddress = requireAddress("rightAddress", rightAddress);
        this.leftAddress = requireAddress("leftAddress", leftAddress);
        this.ringAddress = ringAddress == null ? "" : ringAddress.trim();
        IntentFilter phoneLockFilter = new IntentFilter();
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_ON);
        phoneLockFilter.addAction(Intent.ACTION_SCREEN_OFF);
        phoneLockFilter.addAction(Intent.ACTION_USER_PRESENT);
        appContext.registerReceiver(phoneLockReceiver, phoneLockFilter);
        phoneLockReceiverRegistered = true;
    }


    public void setListener(FaceclawBleCommunicatorListener listener) {
        this.listener = listener;
        emitState();
        emitPhoneLockStateIfChanged(true);
    }

    public void start() {
        synchronized (lock) {
            if (running) {
                return;
            }
            running = true;
            userDisconnectRequested = false;
            shutdownRequested = false;
            activeInstance = this;
            workerThread = new Thread(this, "FaceclawBleCommunicator");
            workerThread.start();
        }
    }

    public void disconnect() {
        releaseFaceclawFramebufferLease();
        Thread threadToJoin;
        synchronized (lock) {
            userDisconnectRequested = true;
            running = false;
            audioCaptureActive = false;
            audioPacketListener = null;
            threadToJoin = workerThread;
        }
        setStateDisplay("disconnecting", "Disconnecting...");
        interruptibleSleep.interrupt();
        if (threadToJoin != null) {
            threadToJoin.interrupt();
            try {
                threadToJoin.join(5_000);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        synchronized (lock) {
            workerThread = null;
            resetSessionStateLocked();
            clearAllMessagesLocked("disconnect");
            // Unknown until the next connection's first push or settings poll.
            silentMode = -1;
        }
        bleManager.disconnect(rightAddress);
        bleManager.disconnect(leftAddress);
        if (hasRingAddress()) {
            bleManager.disconnect(ringAddress);
        }
        bleManager.close();
        releaseG2ScreenWakeLock();
        setStateDisplay("disconnected", "Disconnected.");
    }

    public void close() {
        if (activeInstance == this) {
            activeInstance = null;
        }
        disconnect();
        if (phoneLockReceiverRegistered) {
            phoneLockReceiverRegistered = false;
            appContext.unregisterReceiver(phoneLockReceiver);
        }
    }

    public void setG2ScreenOn(boolean screenOn) {
        mainHandler.post(() -> updateG2ScreenWakeLock(screenOn));
    }

    public void setFirmwareDebugFlags(boolean enabled) {
        // Just record it; the drive loop emits the mode-7 control message when the
        // session is warmed up and idle, and re-emits when this value changes.
        firmwareDebugFlagsEnabled = enabled;
    }

    public boolean startG2AudioCapture(FaceclawAudioPacketListener listener) {
        if (listener == null) {
            throw new IllegalArgumentException("listener is required");
        }
        int magic;
        synchronized (lock) {
            if (!running || !sessionReady || shutdownRequested || !fixedLayoutCreated || !warmedUp) {
                logLine("skip G2 mic enable; EvenHub display path not ready");
                return false;
            }
            audioPacketListener = listener;
            OutboundMessage message = createAudioControlMessageLocked(true);
            magic = message.magic;
            pendingMessages.addFirst(message);
            logLine("queue G2 mic enable");
        }
        interruptibleSleep.interrupt();
        return waitForAudioControlAck(magic, "enable");
    }

    public void stopG2AudioCapture() {
        int magic = 0;
        synchronized (lock) {
            audioPacketListener = null;
            audioCaptureActive = false;
            clearMessagesOfKindLocked("audio-control");
            if (running && sessionReady) {
                OutboundMessage message = createAudioControlMessageLocked(false);
                magic = message.magic;
                pendingMessages.addFirst(message);
                logLine("queue G2 mic disable");
            }
        }
        interruptibleSleep.interrupt();
        if (magic != 0) {
            waitForAudioControlAck(magic, "disable");
        }
    }

    public boolean isSessionReady() {
        synchronized (lock) {
            return running && sessionReady;
        }
    }

    /**
     * Acquire/renew or release CFW's volatile wake-takeover lease on both
     * arms. Delivery (not a protocol ACK) is awaited so a caller can ensure
     * the fail-open firmware policy is installed before relying on wakeword
     * interception or suspending EvenHub.
     */
    public boolean setFaceclawWakeLeaseEnabled(boolean enabled) {
        int generation;
        synchronized (lock) {
            faceclawWakeLeaseEnabled = enabled;
            if (!running || !sessionReady) {
                return !enabled;
            }
            generation = enqueueFaceclawWakeControlLocked(
                enabled ? BleProtocol.FACECLAW_WAKE_OP_ACQUIRE : BleProtocol.FACECLAW_WAKE_OP_RELEASE,
                0,
                true
            );
            if (!enabled) {
                faceclawWakePendingNonce = -1;
            }
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawWakeControlDelivery(generation, FACECLAW_WAKE_CONTROL_WAIT_MS);
    }

    /**
     * Wait until the recreated layout, warmup, and retained compositor frame
     * have all landed. If this wake came from CFW's deferred double tap, READY
     * is then sent to both arms to cancel their stock-dashboard fallback.
     */
    public boolean awaitEvenHubSessionReady(int timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        int readyGeneration = 0;
        synchronized (lock) {
            while (running && sessionReady) {
                boolean frameReady = false;
                synchronized (desiredTilesLock) {
                    frameReady = !desiredFingerprint.isEmpty()
                        && desiredFingerprint.equals(displayedFingerprint);
                }
                if (!shutdownRequested && fixedLayoutCreated && warmedUp && frameReady) {
                    if (faceclawWakePendingNonce >= 0) {
                        readyGeneration = enqueueFaceclawWakeControlLocked(
                            BleProtocol.FACECLAW_WAKE_OP_READY,
                            faceclawWakePendingNonce,
                            true
                        );
                        faceclawWakePendingNonce = -1;
                    }
                    break;
                }
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return false;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    return false;
                }
            }
            if (!running || !sessionReady) {
                return false;
            }
        }
        if (readyGeneration != 0) {
            interruptibleSleep.interrupt();
            if (!waitForFaceclawWakeControlDelivery(readyGeneration, FACECLAW_WAKE_CONTROL_WAIT_MS)) {
                logLine("wake READY delivery not confirmed before fallback deadline");
            }
        }
        return true;
    }

    /**
     * Enable or disable the IMU (accelerometer) report stream. Fire-and-forget:
     * the control message is queued ahead of other traffic; readings arrive via
     * registered FaceclawImuListeners. reportFrq is the requested sample rate
     * (ignored on disable).
     */
    public void setImuReportEnabled(boolean enable, int reportFrq) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip IMU " + (enable ? "enable" : "disable") + "; session not ready");
                return;
            }
            clearMessagesOfKindLocked("imu-control");
            OutboundMessage message = messageBuilder.enableOrDisableImu(enable, reportFrq);
            message.onTimeout = () -> logLine("IMU control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue IMU " + (enable ? "enable freq=" + reportFrq : "disable"));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable/disable the stock compass through CFW image-handler mode 10. The
     * desired state is retained across reconnects; headings arrive through
     * stock sid-0x08 navigation notifications and FaceclawCompassListeners.
     */
    public void setCompassEnabled(boolean enable) {
        synchronized (lock) {
            compassEnabled = enable;
            compassControlLastSent = -1;
            clearMessagesOfKindLocked("compass-control");
            if (running && sessionReady && !shutdownRequested && fixedLayoutCreated && warmedUp) {
                enqueueCompassControlLocked(true, compassEnabled);
            } else {
                logLine("defer compass " + (enable ? "enable" : "disable") + "; display path not ready");
            }
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Set the lens brightness. Fire-and-forget, like the IMU control: the
     * message is queued ahead of other traffic and any not-yet-sent brightness
     * message is superseded. When autoAdjust is true the ambient-light sensor
     * drives brightness and brightnessLevel is ignored; otherwise
     * brightnessLevel (0-100) is applied directly.
     */
    public void setBrightness(boolean autoAdjust, int brightnessLevel) {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip brightness set; session not ready");
                return;
            }
            clearMessagesOfKindLocked("brightness-control");
            OutboundMessage message = messageBuilder.setBrightness(autoAdjust, brightnessLevel);
            message.onTimeout = () -> logLine("brightness control ack timeout");
            pendingMessages.addFirst(message);
            logLine("queue brightness " + (autoAdjust ? "auto" : "level=" + brightnessLevel));
        }
        interruptibleSleep.interrupt();
    }

    /**
     * Enable the stock wear detector, then ask CFW to emit its current cached
     * state. The queue order matters: the query must run after the setting is
     * applied, including on a fresh install where wear detection was disabled.
     */
    public void enableWearDetectionAndRequestState() {
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip wear detector setup; session not ready");
                return;
            }
            clearMessagesOfKindLocked("wear-detection-control");
            clearMessagesOfKindLocked("wear-query-control");
            OutboundMessage queryLeft = messageBuilder.faceclawWearQuery(true);
            OutboundMessage queryRight = messageBuilder.faceclawWearQuery(false);
            OutboundMessage enable = messageBuilder.setWearDetection(true);
            enable.onTimeout = () -> logLine("wear detection enable ack timeout");
            pendingMessages.addFirst(queryLeft);
            pendingMessages.addFirst(queryRight);
            pendingMessages.addFirst(enable);
            logLine("queue wear detection enable + current-state query");
        }
        interruptibleSleep.interrupt();
    }

    public void addImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.add(listener);
        }
    }

    public void removeImuListener(FaceclawImuListener listener) {
        if (listener != null) {
            imuListeners.remove(listener);
        }
    }

    public void addCompassListener(FaceclawCompassListener listener) {
        if (listener != null) {
            compassListeners.add(listener);
        }
    }

    public void removeCompassListener(FaceclawCompassListener listener) {
        if (listener != null) {
            compassListeners.remove(listener);
        }
    }


    // The most recently started communicator; lets app worker threads submit
    // surface frames without holding a cross-isolate reference to the bridge
    // object (JS wrappers do not cross isolates, but the Java instance does).
    private static volatile FaceclawBleCommunicator activeInstance;

    public static FaceclawBleCommunicator getActive() {
        return activeInstance;
    }

    /** Set the compositor's output frame size. Call before configuring surfaces. */
    public void configureCompositorScreen(int width, int height) {
        compositor.configureScreen(width, height);
    }

    /**
     * The current composited screen as a phone-UI preview bitmap, or null
     * before any surface has been configured. Built from the compositor so
     * the preview reflects every surface (chrome + whichever app is
     * foreground), including worker-app frames the TS side never sees.
     */
    public android.graphics.Bitmap getCompositePreviewBitmap(double brightenGamma) {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return null;
        }
        return PreviewBitmapUtil.fromGray(
                java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height, brightenGamma);
    }

    /** Save the current composite as a 4-bit grayscale PNG; returns the path or "". */
    public String saveCompositePngScreenshot() throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
    }

    /**
     * Save the current composite cropped to the given screen rect (the region
     * the shell says is actually occupied). The rect is clamped to the screen;
     * a degenerate rect falls back to the full screen.
     */
    public String saveCompositePngScreenshot(int cropX, int cropY, int cropWidth, int cropHeight)
            throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        int x = Math.max(0, cropX);
        int y = Math.max(0, cropY);
        int width = Math.min(composite.width - x, cropWidth - (x - cropX));
        int height = Math.min(composite.height - y, cropHeight - (y - cropY));
        if (width <= 0 || height <= 0 || (x == 0 && y == 0 && width == composite.width && height == composite.height)) {
            return ScreenshotUtil.savePngScreenshot(appContext, composite.gray, composite.width, composite.height);
        }
        byte[] cropped = new byte[width * height];
        for (int row = 0; row < height; row++) {
            System.arraycopy(composite.gray, (y + row) * composite.width + x, cropped, row * width, width);
        }
        return ScreenshotUtil.savePngScreenshot(appContext, cropped, width, height);
    }

    // Active animated-GIF screen recording, or null when idle. Frames are
    // pushed by recordScreenFrame(), which the TS side calls at each
    // phone-preview flush.
    private volatile GifScreenRecorder screenRecorder;

    /** Begin collecting composite frames for an animated-GIF screen recording. */
    public void startScreenRecording() {
        screenRecorder = new GifScreenRecorder();
    }

    /** Capture the current composite into the active recording; no-op when idle. */
    public void recordScreenFrame() {
        GifScreenRecorder recorder = screenRecorder;
        if (recorder == null) {
            return;
        }
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return;
        }
        recorder.addFrame(composite.gray, composite.width, composite.height, System.currentTimeMillis());
    }

    /** Finish the recording and save it as an animated GIF; returns the path or "". */
    public String stopScreenRecording() throws java.io.IOException {
        GifScreenRecorder recorder = screenRecorder;
        screenRecorder = null;
        if (recorder == null) {
            return "";
        }
        if (recorder.isOverflowed()) {
            logLine("screen recording hit its frame cap; the tail was dropped");
        }
        return recorder.save(appContext);
    }

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    public void setSurfaceVisible(String id, boolean visible) {
        compositor.setSurfaceVisible(id, visible);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, 0);
    }

    /**
     * Blank (screen off) or unblank the composited output, immediately
     * submitting the resulting frame. Retained surface state is untouched, so
     * unblanking restores the previous screen content without repaints.
     */
    public void setScreenBlanked(boolean blanked) {
        compositor.setBlanked(blanked);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, packed, 0, 0);
    }

    /**
     * Create or reconfigure a compositor surface. transparency is one of the
     * SurfaceCompositor.TRANSPARENCY_* constants. Geometry changes take effect
     * when the next frame is submitted.
     */
    public void configureSurface(String id, int x, int y, int width, int height, int zOrder, int transparency) {
        compositor.configureSurface(id, x, y, width, height, zOrder, transparency);
    }

    public void removeSurface(String id) {
        compositor.removeSurface(id);
    }

    /**
     * Apply an update to one compositor surface and submit the recomposited
     * screen as the desired frame. The update covers the rect (rectX, rectY,
     * rectWidth, rectHeight) in surface-local coordinates; contentFingerprint
     * identifies the surface's full content after the update.
     *
     * pixels8bpp arrives as a ByteBuffer because NativeScript marshals a JS
     * ArrayBuffer to one without the per-element bridge copy that a byte[]
     * parameter would need (~150ms for a full frame).
     */
    public void submitSurfaceFrame(
            java.nio.ByteBuffer pixels8bpp,
            String surfaceId,
            int rectX,
            int rectY,
            int rectWidth,
            int rectHeight,
            String contentFingerprint,
            int paintMs,
            int frameId
    ) {
        Log.i(TAG, "Received an updated frame for surface " + surfaceId);
        FrameTimings.getInstance().spanStart(frameId, "composite");
        SurfaceCompositor.Composite composite = compositor.applyAndComposite(
                surfaceId, pixels8bpp, rectX, rectY, rectWidth, rectHeight, contentFingerprint);
        FrameTimings.getInstance().spanEnd(frameId, "composite");
        // Pack the composited 8bpp buffer down to the headerless 4bpp frame
        // format the wire planners consume; BMP framing is added later only on
        // the rare paths that still need it (warmup, uncompressed fallback).
        FrameTimings.getInstance().spanStart(frameId, "pack-4bpp");
        byte[] packed = BmpUtil.pack4bppFromGray8(composite.gray, composite.width, composite.height);
        FrameTimings.getInstance().spanEnd(frameId, "pack-4bpp");
        storeDesiredComposite(composite, packed, paintMs, frameId);
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    private void storeDesiredComposite(SurfaceCompositor.Composite composite, byte[] packed, int paintMs, int frameId) {
        int supersededFrameId = 0;
        boolean stale = false;
        synchronized (desiredTilesLock) {
            if (composite.seq <= lastStoredCompositeSeq) {
                // A concurrent submission composited after us and stored first;
                // its composite already includes this surface update.
                stale = true;
            } else {
                lastStoredCompositeSeq = composite.seq;
                supersededFrameId = desiredFrameId;
                desiredPacked = packed;
                desiredWidth = composite.width;
                desiredHeight = composite.height;
                desiredFingerprint = composite.fingerprint;
                desiredPaintMs = paintMs;
                desiredFrameId = frameId;
            }
        }
        if (stale) {
            finishFrame(frameId, "discarded: composite superseded before store");
            return;
        }
        if (supersededFrameId != 0 && supersededFrameId != frameId) {
            finishFrame(supersededFrameId, "discarded: superseded by frame#" + frameId + " before send");
        }
        FrameTimings.getInstance().log(frameId, "image submitted as desired frame");
        interruptibleSleep.interrupt();
    }

    /**
     * Play a tone sequence via CFW load_image_z mode 5 kind 4. The payload is
     * the complete wire buffer ([5][4][nSteps][freqLo,freqHi,duty,msLo,msHi]*n,
     * up to 48 steps), built on the TS side; it rides the arbitrary-payload
     * image path like the other mode-5 controls.
     */
    public void playBuzzerSequence(java.nio.ByteBuffer payload) {
        synchronized (lock) {
            if (!running || !sessionReady || !fixedLayoutCreated) {
                logLine("skip buzzer sequence; session not ready");
                return;
            }
            byte[] bytes = new byte[payload == null ? 0 : payload.remaining()];
            if (payload != null) {
                payload.get(bytes);
            }
            if (bytes.length < 3) {
                logLine("skip buzzer sequence; empty payload");
                return;
            }
            OutboundMessage message = messageBuilder.imagePayload(
                DASHBOARD_TILE,
                nextMapSessionId(),
                bytes,
                "buzzer sequence " + bytes.length + "B",
                connectionOptions.sendImagesToLeft
            );
            message.onTimeout = () -> {
                handleTransportFailure("buzzer sequence ack timeout");
            };
            pendingMessages.addLast(message);
            logLine("queue " + message.label);
        }
        interruptibleSleep.interrupt();
    }

    /** Enter exclusive video transport mode and pause ordinary compositor images. */
    public boolean beginH264Stream(int streamId) {
        synchronized (lock) {
            if (!running || !sessionReady || !fixedLayoutCreated || !warmedUp) {
                logLine("skip H264 stream; display path not ready");
                return false;
            }
            if (streamId == 0) {
                logLine("skip H264 stream; invalid session id");
                return false;
            }
            clearMessagesOfKindLocked("image");
            h264Transfers.clear();
            h264TransferResults.clear();
            h264TransferResultOrder.clear();
            h264StreamFailed = false;
            h264Streaming = true;
            h264Ending = false;
            h264EndResult = 0;
            h264EndDeadlineMs = 0;
            h264EndTransfer = null;
            h264StreamId = streamId;
            h264HighestQueuedSeq = 0;
            h264DecodedSeq = 0;
            h264PresentedSeq = 0;
            h264RetryCount = 0;
            h264MaxFirmwareQueueDepth = 0;
            h264MaxOutstanding = 0;
            h264MaxOutstandingBytes = 0;
            h264FirmwareQueueCapacity = H264_STARTUP_WINDOW;
            h264FirmwareQueuedBytes = 0;
            h264FirmwareFrames = 0;
            h264TelemetryVersion = 0;
            h264FirstPresentationAtMs = 0;
            h264LastPresentationAtMs = 0;
            h264PresentationIntervals = 0;
            h264MaxPresentationGapMs = 0;
            h264LeftPresentedSeq = 0;
            h264RightPresentedSeq = 0;
            h264MaxLensSequenceSkew = 0;
            h264LeftDecodedSeq = 0;
            h264RightDecodedSeq = 0;
            h264LeftQueueDepth = 0;
            h264RightQueueDepth = 0;
            h264LeftTelemetrySeen = false;
            h264RightTelemetrySeen = false;
            h264AdmissionPaused = false;
            h264AdmissionPauseReason = "";
            h264AdmissionPauseStartedAtMs = 0;
            h264AdmissionPauseTotalMs = 0;
            h264AdmissionPauseMaxMs = 0;
            h264AdmissionPauseCount = 0;
            h264FirmwareEmptyDeferredCallbacks = 0;
            h264FirmwareBacklogDeferredCallbacks = 0;
            h264FirmwarePaceScheduled = 0;
            h264FirmwarePaceFired = 0;
            h264FirmwarePaceDirect = 0;
            h264FirmwarePaceLate = 0;
            h264FirmwarePaceMaxLateMs = 0;
            h264DisplayTimingSamples = 0;
            h264DisplayGateWaitTotalUs = 0;
            h264DisplayGateWaitMaxUs = 0;
            h264DisplayPresentTotalUs = 0;
            h264DisplayPresentMaxUs = 0;
            enableWearDetectionAndRequestState();
            logLine("H264 stream transport begin session=" + unsignedInt(streamId)
                + " startupWindow=" + H264_STARTUP_WINDOW
                + " decoderWindow=" + H264_LOGICAL_WINDOW
                + " bleWindow=" + H264_BLE_WINDOW
                + " byteBudget=" + H264_PAYLOAD_BUDGET_BYTES);
        }
        interruptibleSleep.interrupt();
        return true;
    }

    /**
     * Enqueue a mode-11 control without waiting on the caller's thread.
     * Returns a positive transfer id, or -1 when the display path is unavailable.
     */
    public int enqueueH264Control(java.nio.ByteBuffer payload) {
        byte[] bytes = copyH264Payload(payload);
        if (bytes == null || (bytes[1] & 0xff) == 6) return -1;

        H264Transfer transfer;
        synchronized (lock) {
            if (h264Ending) return -1;
            transfer = enqueueH264PayloadLocked(bytes, false);
        }
        if (transfer == null) return -1;
        interruptibleSleep.interrupt();
        return transfer.id;
    }

    /** Poll a transfer created by enqueueH264Control: 1=success, 0=pending, -1=failed. */
    public int pollH264Transfer(int transferId) {
        synchronized (lock) {
            Integer cached = h264TransferResults.remove(transferId);
            if (cached != null) {
                h264TransferResultOrder.remove(transferId);
                return cached;
            }
            for (H264Transfer transfer : h264Transfers) {
                if (transfer.id != transferId) continue;
                if (!transfer.terminal) {
                    return running && sessionReady ? 0 : -1;
                }
                return transfer.failed ? -1 : 1;
            }
            return -1;
        }
    }

    /**
     * Non-blocking decoder-window enqueue. Returns a positive transfer id when
     * queued, zero for backpressure, or -1 for a terminal/unavailable stream.
     */
    public int tryQueueH264Payload(java.nio.ByteBuffer payload) {
        byte[] bytes = copyH264Payload(payload);
        if (bytes == null || (bytes[1] & 0xff) != 6) return -1;

        H264Transfer transfer;
        synchronized (lock) {
            if (!h264Streaming || h264Ending || h264StreamFailed) return -1;
            if (!h264HasCapacityLocked(bytes.length)) return 0;
            transfer = enqueueH264PayloadLocked(bytes, false);
        }
        if (transfer == null) return -1;
        interruptibleSleep.interrupt();
        return transfer.id;
    }

    /** Poll decoder-confirmed drain state: 1=drained, 0=pending, -1=failed. */
    public int pollH264Drain() {
        synchronized (lock) {
            if (!running || !sessionReady || !h264Streaming || h264StreamFailed) return -1;
            checkH264ConfirmationDeadlinesLocked();
            purgeCompletedH264TransfersLocked();
            if (h264StreamFailed) return -1;
            return h264OutstandingNalCountLocked() == 0 ? 1 : 0;
        }
    }

    /** Queue one logical mode-11 payload, blocking only for pipeline capacity. */
    public boolean queueH264Payload(java.nio.ByteBuffer payload) {
        byte[] bytes = copyH264Payload(payload);
        if (bytes == null) return false;

        H264Transfer transfer;
        synchronized (lock) {
            if (!h264Streaming) {
                logLine("skip H264 queue; stream not begun");
                return false;
            }
            if (!waitForH264CapacityLocked(bytes.length)) return false;
            transfer = enqueueH264PayloadLocked(bytes);
        }
        if (transfer == null) return false;
        interruptibleSleep.interrupt();
        return true;
    }

    /** Wait until firmware confirms every queued NAL was decoded in sequence. */
    public boolean drainH264Payloads() {
        synchronized (lock) {
            return waitForH264DrainLocked();
        }
    }

    public String getH264StreamSummary() {
        synchronized (lock) {
            long presentationSpanMs = h264LastPresentationAtMs
                - h264FirstPresentationAtMs;
            double presentationFps = presentationSpanMs > 0
                ? h264PresentationIntervals * 1000.0 / presentationSpanMs
                : 0.0;
            double averageGateWaitMs = h264DisplayTimingSamples > 0
                ? h264DisplayGateWaitTotalUs / 1000.0 / h264DisplayTimingSamples
                : 0.0;
            double averagePresentMs = h264DisplayTimingSamples > 0
                ? h264DisplayPresentTotalUs / 1000.0 / h264DisplayTimingSamples
                : 0.0;
            return "session=" + unsignedInt(h264StreamId)
                + " queued=" + unsignedInt(h264HighestQueuedSeq)
                + " decoded=" + unsignedInt(h264DecodedSeq)
                + " presented=" + unsignedInt(h264PresentedSeq)
                + " retries=" + h264RetryCount
                + " maxQueue=" + h264MaxFirmwareQueueDepth
                + " maxOutstanding=" + h264MaxOutstanding
                + " maxOutstandingBytes=" + h264MaxOutstandingBytes
                + " firmwareQueue=" + h264FirmwareQueuedBytes
                + "/" + H264_PAYLOAD_BUDGET_BYTES
                + " presentFps="
                + String.format(Locale.US, "%.1f", presentationFps)
                + " maxPresentGap=" + h264MaxPresentationGapMs + "ms"
                + " maxLensSkew=" + h264MaxLensSequenceSkew
                + " admissionPauses=" + h264AdmissionPauseCount
                + " admissionPauseMs=" + h264AdmissionPauseTotalMs
                + " admissionPauseMaxMs=" + h264AdmissionPauseMaxMs
                + " syncEmpty=" + h264FirmwareEmptyDeferredCallbacks
                + " syncBacklog=" + h264FirmwareBacklogDeferredCallbacks
                + " pace=" + h264FirmwarePaceFired
                + "/" + h264FirmwarePaceScheduled
                + " direct=" + h264FirmwarePaceDirect
                + " async=" + Math.max(
                    0,
                    h264FirmwarePaceScheduled - h264FirmwarePaceDirect
                )
                + " paceLate=" + h264FirmwarePaceLate
                + " paceMaxLateMs=" + h264FirmwarePaceMaxLateMs
                + " avgGateWaitMs="
                + String.format(Locale.US, "%.1f", averageGateWaitMs)
                + " maxGateWaitMs="
                + String.format(Locale.US, "%.1f", h264DisplayGateWaitMaxUs / 1000.0)
                + " avgPresentMs="
                + String.format(Locale.US, "%.1f", averagePresentMs)
                + " maxPresentMs="
                + String.format(Locale.US, "%.1f", h264DisplayPresentMaxUs / 1000.0)
                + " telemetryV=" + h264TelemetryVersion;
        }
    }

    /** Begin STOP without blocking the caller. Returns 1=already ended, 0=pending, -1=failed. */
    public int requestH264End() {
        int result;
        synchronized (lock) {
            if (!h264Streaming) return 1;
            if (h264Ending) return 0;

            h264Ending = true;
            h264EndResult = 0;
            cancelAllH264MessagesLocked("stream ending");
            h264Transfers.clear();
            h264StreamFailed = false;
            h264EndTransfer = enqueueH264PayloadLocked(new byte[] {11, 0}, true);
            h264EndDeadlineMs = SystemClock.elapsedRealtime() + H264_ASYNC_TIMEOUT_MS;
            if (h264EndTransfer == null) {
                finishH264StreamLocked(false);
                result = -1;
            } else {
                result = 0;
            }
        }
        interruptibleSleep.interrupt();
        if (result < 0) handleTransportFailure("H264 STOP unavailable");
        return result;
    }

    /** Poll STOP and always release local exclusive-video state on failure or timeout. */
    public int pollH264End() {
        int result;
        synchronized (lock) {
            if (!h264Ending) return h264EndResult != 0 ? h264EndResult : 1;

            boolean transportUnavailable = !running || !sessionReady;
            boolean timedOut = SystemClock.elapsedRealtime() >= h264EndDeadlineMs;
            if (h264EndTransfer != null && h264EndTransfer.terminal) {
                finishH264StreamLocked(!h264EndTransfer.failed);
            } else if (transportUnavailable || timedOut) {
                finishH264StreamLocked(false);
            }
            result = h264Ending ? 0 : h264EndResult;
        }
        if (result != 0) interruptibleSleep.interrupt();
        if (result < 0) handleTransportFailure("H264 STOP failed");
        return result;
    }

    private void finishH264StreamLocked(boolean stopped) {
        cancelAllH264MessagesLocked("stream ended");
        h264Transfers.clear();
        h264Streaming = false;
        h264StreamFailed = false;
        h264StreamId = 0;
        h264Ending = false;
        h264EndResult = stopped ? 1 : -1;
        h264EndDeadlineMs = 0;
        h264EndTransfer = null;
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
        displayedFingerprint = "";
        imageRetryAfterMs = 0;
        lock.notifyAll();
        logLine("H264 stream transport end stopped=" + stopped);
    }

    /** Compatibility path; new callers use requestH264End/pollH264End. */
    public boolean endH264Stream() {
        int result = requestH264End();
        while (result == 0) {
            synchronized (lock) {
                try {
                    lock.wait(50);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            result = pollH264End();
        }
        return result == 1;
    }

    /** Compatibility/synchronous path used by START, STOP, probe and status controls. */
    public boolean sendH264Payload(java.nio.ByteBuffer payload) {
        byte[] bytes = copyH264Payload(payload);
        if (bytes == null) return false;

        final H264Transfer transfer;
        synchronized (lock) {
            if (h264Streaming && !waitForH264CapacityLocked(bytes.length)) return false;
            transfer = enqueueH264PayloadLocked(bytes, false);
        }
        if (transfer == null) return false;
        interruptibleSleep.interrupt();
        synchronized (lock) {
            return waitForH264TransferLocked(transfer);
        }
    }

    private byte[] copyH264Payload(java.nio.ByteBuffer payload) {
        java.nio.ByteBuffer view = payload == null ? null : payload.duplicate();
        byte[] bytes = new byte[view == null ? 0 : view.remaining()];
        if (view != null) view.get(bytes);
        if (bytes.length < 2 || (bytes[0] & 0xff) != 11) {
            logLine("skip H264 payload; invalid mode-11 packet");
            return null;
        }
        return bytes;
    }

    private H264Transfer enqueueH264PayloadLocked(byte[] bytes) {
        return enqueueH264PayloadLocked(bytes, false);
    }

    private H264Transfer enqueueH264PayloadLocked(byte[] bytes, boolean priority) {
        if (!running || !sessionReady || !fixedLayoutCreated || !warmedUp) {
            logLine("skip H264 payload; display path not ready");
            return null;
        }

        int transferId = nextH264TransferId++;
        if (nextH264TransferId <= 0) nextH264TransferId = 1;
        int sub = bytes.length >= 2 ? bytes[1] & 0xff : -1;
        int wireStreamId = sub == 6 && bytes.length >= 10 ? readLe32(bytes, 2) : 0;
        int sequence = sub == 6 && bytes.length >= 10 ? readLe32(bytes, 6) : 0;
        if (sub == 6 && (!h264Streaming || wireStreamId != h264StreamId || sequence <= 0)) {
            logLine("skip H264 NAL; invalid session/sequence");
            return null;
        }

        H264Transfer transfer = new H264Transfer(
            transferId, bytes, wireStreamId, sequence
        );
        h264Transfers.addLast(transfer);
        h264MaxOutstanding = Math.max(h264MaxOutstanding, h264Transfers.size());
        h264MaxOutstandingBytes = Math.max(
            h264MaxOutstandingBytes,
            h264OutstandingBytesLocked()
        );
        if (sequence > h264HighestQueuedSeq) h264HighestQueuedSeq = sequence;
        if (!enqueueH264AttemptLocked(transfer, false, priority)) {
            h264Transfers.remove(transfer);
            return null;
        }
        return transfer;
    }

    private boolean enqueueH264AttemptLocked(
        H264Transfer transfer,
        boolean replay,
        boolean priority
    ) {
        BleImageOptimizer.TileImagePlan plan = new BleImageOptimizer.TileImagePlan(
            0, DASHBOARD_TILE, new byte[0], 0, 0, nextMapSessionId(), transfer.payload
        );
        plan.fragments = BleImageOptimizer.planImageFragments(
            plan.payload, H264_FRAGMENT_SIZE
        );
        int fragmentCount = plan.fragments.size();
        if (fragmentCount == 0) {
            logLine("skip H264 payload; no fragments");
            return false;
        }

        transfer.fragmentCount = fragmentCount;
        transfer.acknowledgedFragments = 0;
        transfer.sentFragments = 0;
        transfer.transportAcked = false;
        transfer.retryPending = false;
        transfer.confirmationDeadlineMs = 0;
        int generation = ++transfer.wireGeneration;

        ArrayList<OutboundMessage> messages = new ArrayList<>();
        for (BleProtocol.ImageFragment fragment : plan.fragments) {
            OutboundMessage message = messageBuilder.imageFragment(
                fragment, plan, true, H264_SEND_TO_LEFT
            );
            message.h264Payload = true;
            message.h264TransferId = transfer.id;
            message.h264Generation = generation;
            message.onSent = () -> markH264FragmentSentLocked(transfer, generation);
            message.onAck = () -> markH264FragmentAckedLocked(transfer, generation);
            message.onTimeout = () -> handleH264FragmentTimeoutLocked(transfer, generation);
            messages.add(message);
        }
        if (priority) {
            for (int i = messages.size() - 1; i >= 0; i--) {
                pendingMessages.addFirst(messages.get(i));
            }
        } else {
            for (OutboundMessage message : messages) pendingMessages.addLast(message);
        }
        logLine("queue H264 transfer=" + transfer.id
            + (transfer.sequence > 0 ? " seq=" + unsignedInt(transfer.sequence) : " control")
            + " generation=" + generation
            + " retry=" + transfer.retryCount
            + (replay ? " replay" : "")
            + " " + transfer.payload.length
            + "B fragments=" + fragmentCount + " outstanding=" + h264Transfers.size());
        return true;
    }

    private void markH264FragmentSentLocked(H264Transfer transfer, int generation) {
        if (!isCurrentH264AttemptLocked(transfer, generation)) return;
        transfer.sentFragments++;
        lock.notifyAll();
    }

    private void markH264FragmentAckedLocked(H264Transfer transfer, int generation) {
        if (!isCurrentH264AttemptLocked(transfer, generation)) return;
        transfer.acknowledgedFragments++;
        lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
        if (transfer.acknowledgedFragments >= transfer.fragmentCount) {
            transfer.transportAcked = true;
            if (transfer.sequence > 0) {
                transfer.confirmationDeadlineMs =
                    SystemClock.elapsedRealtime() + H264_DECODER_CONFIRM_MS;
            }
            if (transfer.sequence == 0) transfer.terminal = true;
            logLine("H264 transport ack id=" + transfer.id
                + (transfer.sequence > 0 ? " seq=" + unsignedInt(transfer.sequence) : " control")
                + " fragments=" + transfer.fragmentCount);
        }
        lock.notifyAll();
    }

    private void handleH264FragmentTimeoutLocked(H264Transfer transfer, int generation) {
        if (!isCurrentH264AttemptLocked(transfer, generation)) return;
        if (transfer.sequence == 0) {
            failH264TransferLocked(transfer, "transport ACK timeout");
            return;
        }

        H264Transfer head = firstOutstandingH264NalLocked();
        if (head != transfer) {
            transfer.retryPending = true;
            transfer.confirmationDeadlineMs = 0;
            logLine("H264 postpone retry seq=" + unsignedInt(transfer.sequence)
                + " behind expected seq="
                + (head == null ? "none" : unsignedInt(head.sequence)));
            lock.notifyAll();
            return;
        }

        if (!retryH264TransferLocked(transfer, "transport ACK timeout")) {
            failH264TransferLocked(transfer, "transport ACK timeout after retry");
        }
    }

    private boolean retryH264TransferLocked(H264Transfer transfer, String reason) {
        if (transfer.terminal || transfer.decoderConfirmed
                || transfer.retryCount >= H264_MAX_RETRIES) {
            return false;
        }
        transfer.wireGeneration++;
        cancelH264TransferMessagesLocked(transfer.id, "H264 retry: " + reason);
        transfer.retryCount++;
        transfer.recoveryInProgress = true;
        h264RetryCount++;
        logLine("H264 retry seq=" + unsignedInt(transfer.sequence)
            + " reason=" + reason + " retry=" + transfer.retryCount);
        boolean queued = enqueueH264AttemptLocked(transfer, false, true);
        if (queued) interruptibleSleep.interrupt();
        return queued;
    }

    private void failH264TransferLocked(H264Transfer transfer, String reason) {
        if (transfer.terminal) return;
        transfer.failed = true;
        transfer.terminal = true;
        transfer.wireGeneration++;
        h264StreamFailed = h264Streaming;
        cancelH264TransferMessagesLocked(transfer.id, "H264 failed: " + reason);
        logLine("H264 transfer failed id=" + transfer.id
            + (transfer.sequence > 0 ? " seq=" + unsignedInt(transfer.sequence) : " control")
            + " reason=" + reason);
        lock.notifyAll();
    }

    private void checkH264ConfirmationDeadlinesLocked() {
        long now = SystemClock.elapsedRealtime();
        H264Transfer transfer = firstOutstandingH264NalLocked();
        if (transfer == null) return;
        if (transfer.retryPending) {
            if (!retryH264TransferLocked(transfer, "deferred transport retry")) {
                failH264TransferLocked(transfer, "deferred transport retry unavailable");
            }
            return;
        }
        if (transfer.confirmationDeadlineMs == 0
                || transfer.confirmationDeadlineMs > now) return;
        if (!retryH264TransferLocked(transfer, "decoder confirmation timeout")) {
            failH264TransferLocked(transfer, "decoder confirmation timeout after retry");
        }
    }

    private H264Transfer firstOutstandingH264NalLocked() {
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence > 0) return transfer;
        }
        return null;
    }

    private boolean isCurrentH264AttemptLocked(H264Transfer transfer, int generation) {
        return transfer != null
            && !transfer.terminal
            && transfer.wireGeneration == generation;
    }

    private boolean isCurrentH264MessageLocked(OutboundMessage message) {
        if (message == null || !message.h264Payload || message.cancelled) return false;
        for (H264Transfer transfer : h264Transfers) {
            if (transfer.id == message.h264TransferId) {
                return isCurrentH264AttemptLocked(transfer, message.h264Generation);
            }
        }
        return false;
    }

    private void purgeCompletedH264TransfersLocked() {
        while (!h264Transfers.isEmpty() && h264Transfers.peekFirst().terminal) {
            H264Transfer finished = h264Transfers.removeFirst();
            recordH264TransferResultLocked(finished.id, finished.failed ? -1 : 1);
            if (finished.failed) h264StreamFailed = h264Streaming;
        }
    }

    private void recordH264TransferResultLocked(int transferId, int result) {
        if (!h264TransferResults.containsKey(transferId)) {
            h264TransferResultOrder.addLast(transferId);
        }
        h264TransferResults.put(transferId, result);
        while (h264TransferResultOrder.size() > H264_RESULT_CACHE_SIZE) {
            Integer expired = h264TransferResultOrder.removeFirst();
            h264TransferResults.remove(expired);
        }
    }

    private int h264OutstandingBytesLocked() {
        int bytes = 0;
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence > 0) {
                bytes += transfer.payload.length;
            }
        }
        return bytes;
    }

    private int h264OutstandingNalCountLocked() {
        int count = 0;
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence > 0) count++;
        }
        return count;
    }

    private boolean h264RecoveryActiveLocked() {
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence > 0
                    && (transfer.recoveryInProgress || transfer.retryPending)) {
                return true;
            }
        }
        return false;
    }

    private int h264EffectiveWindowLocked() {
        if (h264TelemetryVersion < 3 || h264FirmwareFrames == 0) {
            return H264_STARTUP_WINDOW;
        }
        int endToEndCapacity = h264FirmwareQueueCapacity
            + Math.max(1, connectionOptions.WINDOW_SIZE);
        return Math.max(
            1,
            Math.min(H264_LOGICAL_WINDOW, endToEndCapacity)
        );
    }

    /**
     * V12+ telemetry is emitted independently by both lenses. Keep the normal
     * four-NAL preparation window while the two pipelines agree, but stop
     * admitting more data when the observed lens separation exceeds the clean
     * run's one-sequence notification jitter or either snapshot FIFO reaches
     * two entries. The clean 5 fps hardware run peaked at one queued snapshot;
     * the visibly desynchronised 9.8 fps run peaked at three.
     */
    private boolean h264LensAdmissionReadyLocked() {
        String reason = null;
        if (h264TelemetryVersion >= 11
                && h264FirmwareFrames > 0
                && h264LeftTelemetrySeen
                && h264RightTelemetrySeen) {
            long presentationSkew = Math.abs(
                Integer.toUnsignedLong(h264LeftPresentedSeq)
                    - Integer.toUnsignedLong(h264RightPresentedSeq)
            );
            long decoderSkew = Math.abs(
                Integer.toUnsignedLong(h264LeftDecodedSeq)
                    - Integer.toUnsignedLong(h264RightDecodedSeq)
            );
            int queueDepth = Math.max(h264LeftQueueDepth, h264RightQueueDepth);

            // One sequence of observed skew is normal notification ordering;
            // the clean 5 fps run reported one without visible eye mismatch.
            if (presentationSkew > 1) {
                reason = "presentation-skew=" + presentationSkew;
            } else if (decoderSkew > 1) {
                reason = "decoder-skew=" + decoderSkew;
            } else if (queueDepth >= 2) {
                reason = "firmware-queue=" + queueDepth;
            }
        }

        long now = SystemClock.elapsedRealtime();
        if (reason != null) {
            if (!h264AdmissionPaused) {
                h264AdmissionPaused = true;
                h264AdmissionPauseReason = reason;
                h264AdmissionPauseStartedAtMs = now;
                h264AdmissionPauseCount++;
                logLine("H264 admission pause " + reason
                    + " L=" + unsignedInt(h264LeftPresentedSeq)
                    + " R=" + unsignedInt(h264RightPresentedSeq)
                    + " q=" + h264LeftQueueDepth + "/" + h264RightQueueDepth);
            } else {
                h264AdmissionPauseReason = reason;
            }
            return false;
        }

        if (h264AdmissionPaused) {
            long durationMs = Math.max(0, now - h264AdmissionPauseStartedAtMs);
            h264AdmissionPauseTotalMs += durationMs;
            h264AdmissionPauseMaxMs = Math.max(h264AdmissionPauseMaxMs, durationMs);
            logLine("H264 admission resume after " + durationMs + "ms"
                + " reason=" + h264AdmissionPauseReason);
            h264AdmissionPaused = false;
            h264AdmissionPauseReason = "";
            h264AdmissionPauseStartedAtMs = 0;
        }
        return true;
    }

    private boolean h264HasCapacityLocked(int payloadBytes) {
        checkH264ConfirmationDeadlinesLocked();
        purgeCompletedH264TransfersLocked();
        if (!running || !sessionReady || h264StreamFailed || h264Ending) return false;

        int outstandingCount = h264OutstandingNalCountLocked();
        int outstandingBytes = h264OutstandingBytesLocked();
        boolean byteRoom = outstandingBytes == 0
            || (payloadBytes <= H264_PAYLOAD_BUDGET_BYTES
                && outstandingBytes <= H264_PAYLOAD_BUDGET_BYTES - payloadBytes);
        return !h264RecoveryActiveLocked()
            && h264LensAdmissionReadyLocked()
            && outstandingCount < h264EffectiveWindowLocked()
            && byteRoom;
    }

    private boolean waitForH264CapacityLocked(int payloadBytes) {
        long deadline = SystemClock.elapsedRealtime() + H264_WAIT_TIMEOUT_MS;
        while (running && sessionReady && !h264StreamFailed) {
            if (h264HasCapacityLocked(payloadBytes)) return true;
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            try {
                lock.wait(Math.min(remaining, 100));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        logLine("H264 pipeline capacity wait failed outstanding="
            + h264OutstandingNalCountLocked()
            + " bytes=" + h264OutstandingBytesLocked()
            + " window=" + h264EffectiveWindowLocked());
        return false;
    }

    private boolean waitForH264TransferLocked(H264Transfer transfer) {
        long deadline = SystemClock.elapsedRealtime() + H264_WAIT_TIMEOUT_MS;
        while (running && sessionReady && !transfer.terminal) {
            checkH264ConfirmationDeadlinesLocked();
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            try {
                lock.wait(Math.min(remaining, 100));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        boolean acked = transfer.terminal && !transfer.failed;
        if (!acked) logLine("H264 transfer wait timeout id=" + transfer.id);
        purgeCompletedH264TransfersLocked();
        return acked;
    }

    private boolean waitForH264DrainLocked() {
        long deadline = SystemClock.elapsedRealtime() + H264_WAIT_TIMEOUT_MS;
        while (running && sessionReady && !h264StreamFailed) {
            checkH264ConfirmationDeadlinesLocked();
            purgeCompletedH264TransfersLocked();
            if (h264Transfers.isEmpty()) return true;
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) break;
            try {
                lock.wait(Math.min(remaining, 100));
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        logLine("H264 drain failed outstanding=" + h264Transfers.size());
        return false;
    }

    private void cancelH264TransferMessagesLocked(int transferId, String reason) {
        Iterator<OutboundMessage> pending = pendingMessages.iterator();
        while (pending.hasNext()) {
            OutboundMessage message = pending.next();
            if (message.h264Payload && message.h264TransferId == transferId) {
                pending.remove();
                message.cancelled = true;
                discardPrewriteIfMatchesLocked(message);
                magicPool.release(message.sid, message.magic, message.label, reason);
            }
        }
        Iterator<OutboundMessage> inflight = inFlightMessages.iterator();
        while (inflight.hasNext()) {
            OutboundMessage message = inflight.next();
            if (message.h264Payload && message.h264TransferId == transferId) {
                inflight.remove();
                message.cancelled = true;
                magicPool.release(message.sid, message.magic, message.label, reason);
            }
        }
    }

    private void cancelAllH264MessagesLocked(String reason) {
        Iterator<H264Transfer> transfers = h264Transfers.iterator();
        while (transfers.hasNext()) {
            H264Transfer transfer = transfers.next();
            if (!transfer.terminal) {
                transfer.failed = true;
                transfer.terminal = true;
                transfer.wireGeneration++;
            }
            cancelH264TransferMessagesLocked(transfer.id, reason);
        }
    }

    public boolean sendShutdown(int exitMode) {
        return sendShutdownInternal(exitMode, true);
    }

    /**
     * End the EvenHub page while retaining both arm GATT connections and all
     * notification subscriptions. A missed ACK is intentionally non-fatal:
     * reconnecting Bluetooth here would defeat the power-saving mode.
     */
    public boolean suspendEvenHubSession() {
        if (sendShutdownInternal(0, false)) {
            return true;
        }
        synchronized (lock) {
            // A shutdown ACK can be lost even though the command took effect.
            // If the transport remains intentionally quiesced, callers still
            // need to remember to run the resume path on the next wake.
            return running && sessionReady && shutdownRequested;
        }
    }

    /**
     * Start a fresh EvenHub plugin task on the existing BLE transport, then let
     * the session driver create the layout, warm up the image path, and send
     * the desired frame.
     */
    public boolean resumeEvenHubSession() {
        int claimGeneration = 0;
        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                logLine("skip EvenHub resume; transport not ready");
                return false;
            }
            if (!shutdownRequested) {
                return true;
            }
            if (faceclawWakePendingNonce >= 0
                    && hasPendingOrInflightKindLocked("wake-lease-control")) {
                claimGeneration = faceclawWakeControlGeneration;
            }
            logLine("replaying session prelude for EvenHub resume");
        }

        // A custom double-tap wake has only a short unclaimed fail-open
        // deadline. Let the worker put CLAIM on both arms before the direct
        // prelude write begins.
        if (claimGeneration != 0) {
            waitForFaceclawWakeControlDelivery(claimGeneration, 500);
        }

        try {
            // Empty-name Cmd=9 tears down the whole plugin task, not just its
            // image container. Re-run the launch prelude before Cmd=0 CREATE.
            sendPrelude(true);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            handleTransportFailure("EvenHub resume prelude interrupted");
            return false;
        } catch (Throwable t) {
            logLine("EvenHub resume prelude failed: " + safeMessage(t));
            handleTransportFailure("EvenHub resume prelude failed");
            return false;
        }

        synchronized (lock) {
            if (!running || !sessionReady || chargingMode) {
                return false;
            }
            shutdownRequested = false;
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            audioCaptureActive = false;
            clearAllMessagesPreservingWakeLeaseLocked("EvenHub resume");
            displayedFingerprint = "";
            imageRetryAfterMs = 0;
            lastHeartbeatSentAtMs = 0;
            lastHeartbeatAckedAtMs = 0;
            logLine("EvenHub session resume requested");
        }
        interruptibleSleep.interrupt();
        return true;
    }

    private boolean sendShutdownInternal(int exitMode, boolean reconnectOnTimeout) {
        int magic;
        long startedAtMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            if (!running || !sessionReady) {
                logLine("skip shutdown; session not ready");
                return false;
            }
            if (shutdownRequested) {
                return true;
            }
            shutdownRequested = true;
            // Magic values wrap, so an ACK from a much older suspend must not
            // satisfy this request after enough sleep/wake cycles.
            lastShutdownAckMagic = 0;
            clearPendingMessagesLocked("shutdown requested");
            OutboundMessage message = messageBuilder.shutdown(exitMode);
            magic = message.magic;
            message.onAck = () -> {
                lastShutdownAckMagic = message.magic;
                fixedLayoutCreated = false;
                warmedUp = false;
                displayedFingerprint = "";
            };
            message.onTimeout = () -> {
                if (reconnectOnTimeout) {
                    handleTransportFailure("shutdown ack timeout");
                } else {
                    logLine("EvenHub shutdown ack timeout; keeping BLE connected");
                }
            };
            pendingMessages.addFirst(message);
            logLine("queue shutdown");
            // The stock compass keeps the magnetometer sampling independently of
            // the plugin task, so ending the page does not stop it. Force a
            // disable ahead of the shutdown command whenever it may be running:
            // this also covers a disable that was wiped by the queue flush above
            // or whose ack was lost, and the charging-mode/exit paths where the
            // Compass window never got a chance to release it.
            if (compassMaybeOn && fixedLayoutCreated && warmedUp) {
                enqueueCompassControlLocked(true, false);
            }
        }
        interruptibleSleep.interrupt();

        long ackDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running
                    && sessionReady
                    && lastShutdownAckMagic != magic
                    && lastShutdownExitAtMs < startedAtMs
                    && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = ackDeadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastShutdownAckMagic == magic;
            if (acked) {
                long exitDeadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + 500;
                while (running && sessionReady && lastShutdownExitAtMs < startedAtMs) {
                    long remaining = exitDeadline - SystemClock.elapsedRealtime();
                    if (remaining <= 0) {
                        break;
                    }
                    try {
                        lock.wait(Math.min(remaining, 100));
                    } catch (InterruptedException e) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                }
            }
            return acked || lastShutdownExitAtMs >= startedAtMs;
        }
    }

    private boolean waitForAudioControlAck(int magic, String operation) {
        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.ACK_TIMEOUT_MS + ConnectionOptions.WRITE_TIMEOUT_MS + 500;
        synchronized (lock) {
            while (running && sessionReady && lastAudioControlAckMagic != magic && hasPendingOrInflightMagicLocked(magic)) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            boolean acked = lastAudioControlAckMagic == magic;
            if (!acked) {
                if ("enable".equals(operation)) {
                    audioPacketListener = null;
                    audioCaptureActive = false;
                }
                logLine("G2 mic " + operation + " ack timeout");
            }
            return acked;
        }
    }

    @Override public void run() {
        logLine(String.format(Locale.US, "communicator start R=%s L=%s ring=%s", rightAddress, leftAddress, ringAddress));
        while (true) {
            try {
                if (!running) {
                    Log.w(TAG, "Exiting event looop");
                    break;
                }
                emitPhoneLockStateIfChanged(false);
                if (!sessionReady) {
                    long now = SystemClock.elapsedRealtime();
                    if (now < reconnectAfterMs) {
                        interruptibleSleep.sleep(Math.min(ConnectionOptions.IDLE_SLEEP_MS, reconnectAfterMs - now));
                        continue;
                    }
                    Log.w(TAG, "Attempting to connect");
                    connectLoopOnce();
                    continue;
                }

                if (shouldAttemptRingConnect()) {
                    tryConnectRing("retry");
                    continue;
                }

                long sleepMs = driveSession();
                if (sleepMs > 0) {
                    interruptibleSleep.sleep(sleepMs);
                }
            } catch (Throwable t) {
                logLine("communicator loop error: " + safeMessage(t));
                handleTransportFailure("loop error");
            }
        }
        logLine("communicator stop");
    }

    @Override public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (address == null || characteristicUuid == null || data == null) {
            return;
        }
        String uuid = characteristicUuid.toLowerCase(Locale.US);
        if (isDirectRingNotification(address, uuid)) {
            handleDirectRingNotification(uuid, data);
            return;
        }
        if (BleProtocol.RENDER_NOTIFY_UUID.equals(uuid)) {
            handleRenderNotification(address, data);
            return;
        }
        if (!BleProtocol.NOTIFY_CHAR_UUID.equals(uuid)) {
            return;
        }
        String notifyArm = address.equalsIgnoreCase(leftAddress) ? "L"
            : address.equalsIgnoreCase(rightAddress) ? "R" : "?";
        Log.i(TAG, "BLE_NOTIFY arm=" + notifyArm
            + " address=" + address
            + " uuid=" + characteristicUuid
            + " len=" + data.length);
        StringBuilder notifyHex = new StringBuilder();
        for (byte b : data) notifyHex.append(String.format("%02X", b & 0xFF));
        Log.i(TAG, "BLE_NOTIFY_HEX arm=" + notifyArm + " data=" + notifyHex);
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        H264Telemetry h264Telemetry = parseH264Telemetry(frame);
        int decodedWearState = BleProtocol.parseWearState(frame);
        BleProtocol.CompassEvent compassEvent = address.equalsIgnoreCase(rightAddress)
            ? BleProtocol.parseCompassEvent(frame)
            : null;
        boolean emitWearState = false;
        G2Event event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
            if (h264Telemetry != null) {
                handleH264TelemetryLocked(address, h264Telemetry);
            }
            if (decodedWearState >= 0 && decodedWearState != wearState) {
                wearState = decodedWearState;
                emitWearState = true;
            }
            boolean faceclawWakeNotification = false;
            if (shutdownRequested
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING
                    && address.equalsIgnoreCase(rightAddress)) {
                int wakeNonce = BleProtocol.parseFaceclawWakeEvent(frame.pb);
                if (wakeNonce >= 0) {
                    faceclawWakePendingNonce = wakeNonce;
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_CLAIM,
                        wakeNonce,
                        true
                    );
                    faceclawWakeNotification = true;
                    lastConnectionOrInputAtMs = lastIncomingAtMs;
                    event = new G2Event(
                        "display-wake",
                        "",
                        BleProtocol.EVENT_DOUBLE_CLICK,
                        0,
                        0
                    );
                    logLine("claimed deferred dashboard wake nonce=" + wakeNonce);
                }
            }
            if (!faceclawWakeNotification
                    && shutdownRequested
                    && address.equalsIgnoreCase(rightAddress)
                    && BleProtocol.isDisplayWakeStateChange(frame)) {
                // With no EvenHub page, ring/arm double-taps are handled by the
                // stock display lifecycle and surface only as this state ping.
                // Translate it back into an input event so TS can wake the shell
                // and recreate the page.
                event = new G2Event(
                    "display-wake",
                    "",
                    BleProtocol.EVENT_DOUBLE_CLICK,
                    0,
                    0
                );
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.sid == BleProtocol.SID_UI_SETTING) {
                // Device-initiated settings push. It carries a magic the glasses
                // chose, so it would otherwise fall through to resolveAckLocked,
                // match nothing, and be logged as an unexpected ack.
                int pushedSilentMode = BleProtocol.parseSilentModePush(frame.pb);
                if (pushedSilentMode >= 0) {
                    updateSilentModeLocked(pushedSilentMode > 0);
                    return;
                }
            }
            if (!faceclawWakeNotification
                    && decodedWearState < 0
                    && frame.ok
                    && frame.msgSeq >= 0
                    && frame.flag != BleProtocol.FLAG_NOTIFY
                    && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
                if (h264Streaming) {
                    Log.i(TAG, "H264ACKRX arm=" + notifyArm
                        + " sid=" + frame.sid
                        + " magic=" + frame.msgSeq);
                }
                resolveAckLocked(frame.sid, frame.msgSeq, frame.pb);
            }
            if (!faceclawWakeNotification
                    && event == null
                    && frame.ok
                    && address.equalsIgnoreCase(rightAddress)
                    && (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT)) {
                event = G2Event.decode(frame);
                if (event != null) {
                    // Pure IMU samples arrive continuously; don't let them count
                    // as user input (which would starve battery polling).
                    boolean pureImuSample = "sys-event".equals(event.kind)
                        && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
                    if (!pureImuSample) {
                        lastConnectionOrInputAtMs = lastIncomingAtMs;
                    }
                    if ("list-click".equals(event.kind) || "text-click".equals(event.kind)) {
                        // Container-routed touchpad input reached us, so the
                        // firmware is dispatching input: silent mode is off,
                        // whether or not its end-of-silent push arrived.
                        updateSilentModeLocked(false);
                    }
                    if ("sys-event".equals(event.kind)) {
                        if (event.eventType == BleProtocol.EVENT_FOREGROUND_EXIT || event.eventType == BleProtocol.EVENT_ABNORMAL_EXIT || event.eventType == BleProtocol.EVENT_SYSTEM_EXIT) {
                            if (shutdownRequested) {
                                lastShutdownExitAtMs = SystemClock.elapsedRealtime();
                            }
                            fixedLayoutCreated = false;
                            warmedUp = false;
                            displayedFingerprint = "";
                            clearAllMessagesLocked("firmware exit event");
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt();
        if (emitWearState) {
            logLine(decodedWearState > 0 ? "wear state ON_HEAD" : "wear state OFF_HEAD");
            emitWearState(decodedWearState > 0);
        }
        if (compassEvent != null) {
            emitCompassEvent(compassEvent.command, compassEvent.headingDegrees);
        }
        if (event != null) {
            if (event.hasImu) {
                emitImuData(event.imuX, event.imuY, event.imuZ, event.eventSource);
            }
            // A standalone IMU_DATA_REPORT is a sensor sample, not a gesture:
            // deliver it only to IMU listeners, skipping the input pipeline (and
            // its per-frame latency bookkeeping) to avoid flooding it.
            boolean pureImuSample = "sys-event".equals(event.kind)
                && event.eventType == BleProtocol.EVENT_IMU_DATA_REPORT;
            if (!pureImuSample) {
                int frameId = FrameTimings.getInstance().startFrame(
                    "input:" + event.kind + " type=" + event.eventType + " src=" + event.eventSource);
                FrameTimings.getInstance().log(frameId, "input event decoded from BLE notification");
                emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode, frameId);
            }
        }
    }

    private void handleH264TelemetryLocked(String address, H264Telemetry telemetry) {        boolean isLeft =
            address.equalsIgnoreCase(leftAddress) && telemetry.side == 2;
        boolean isRight =
            address.equalsIgnoreCase(rightAddress) && telemetry.side == 1;

        if (!isLeft && !isRight) {
            logLine("H264STAT UNKNOWN addr=" + address
                + " fwside=" + telemetry.side
                + " session=" + unsignedInt(telemetry.streamId));
            return;
        }
        if (telemetry.version < 2 || telemetry.version > 18) {
            if (h264Streaming) failH264StreamLocked("firmware lacks h264seq2 telemetry");
            return;
        }
        if (h264Streaming && telemetry.streamId != h264StreamId) {
            logLine("H264STAT stale session=" + unsignedInt(telemetry.streamId)
                + " active=" + unsignedInt(h264StreamId));
            return;
        }

        if (isRight && Integer.compareUnsigned(telemetry.decodedSeq, h264DecodedSeq) < 0) {
            logLine("H264STAT stale progress dec=" + unsignedInt(telemetry.decodedSeq)
                + " activeDec=" + unsignedInt(h264DecodedSeq));
            return;
        }

        h264TelemetryVersion = Math.max(h264TelemetryVersion, telemetry.version);

        if (isLeft) {
            h264LeftTelemetrySeen = true;
            h264LeftDecodedSeq = telemetry.decodedSeq;
            h264LeftQueueDepth = telemetry.queueDepth;
        }
        if (isRight) {
            h264RightTelemetrySeen = true;
            h264RightDecodedSeq = telemetry.decodedSeq;
            h264RightQueueDepth = telemetry.queueDepth;
        }

        if (isLeft && Integer.compareUnsigned(
                telemetry.presentedSeq, h264LeftPresentedSeq) > 0) {
            h264LeftPresentedSeq = telemetry.presentedSeq;
        }
        if (isRight && Integer.compareUnsigned(
                telemetry.presentedSeq, h264RightPresentedSeq) > 0) {
            h264RightPresentedSeq = telemetry.presentedSeq;
        }
        if (h264LeftPresentedSeq != 0 && h264RightPresentedSeq != 0) {
            long lensSkew = Math.abs(
                Integer.toUnsignedLong(h264LeftPresentedSeq)
                    - Integer.toUnsignedLong(h264RightPresentedSeq)
            );
            h264MaxLensSequenceSkew = Math.max(
                h264MaxLensSequenceSkew,
                lensSkew
            );
        }

        if (isRight) {
            h264DecodedSeq = telemetry.decodedSeq;
            if (telemetry.version == 12) {
                h264FirmwareEmptyDeferredCallbacks =
                    telemetry.emptyDeferredCallbacks;
                h264FirmwareBacklogDeferredCallbacks =
                    telemetry.backlogDeferredCallbacks;
            }
            if (telemetry.version >= 13 && telemetry.result != 0xff) {
                h264FirmwarePaceScheduled = telemetry.paceScheduled;
                h264FirmwarePaceFired = telemetry.paceFired;
                h264FirmwarePaceDirect = telemetry.paceDirect;
                h264FirmwarePaceLate = telemetry.paceLate;
                h264FirmwarePaceMaxLateMs = telemetry.paceMaxLateMs;
            }
            if (Integer.compareUnsigned(telemetry.presentedSeq, h264PresentedSeq) > 0) {
                long presentedAtMs = SystemClock.elapsedRealtime();
                if (h264FirstPresentationAtMs == 0) {
                    h264FirstPresentationAtMs = presentedAtMs;
                } else if (h264LastPresentationAtMs > 0) {
                    long sequenceDelta = Integer.toUnsignedLong(telemetry.presentedSeq)
                        - Integer.toUnsignedLong(h264PresentedSeq);
                    if (sequenceDelta > 0) {
                        long elapsedMs = presentedAtMs - h264LastPresentationAtMs;
                        long normalizedGapMs =
                            (elapsedMs + sequenceDelta - 1) / sequenceDelta;
                        h264PresentationIntervals += sequenceDelta;
                        h264MaxPresentationGapMs = Math.max(
                            h264MaxPresentationGapMs,
                            normalizedGapMs
                        );
                    }
                }
                if (telemetry.version >= 14 && telemetry.result != 0xff) {
                    long gateWaitUs = Integer.toUnsignedLong(
                        telemetry.displayGateWaitUs
                    );
                    long presentUs = Integer.toUnsignedLong(
                        telemetry.displayPresentUs
                    );
                    h264DisplayTimingSamples++;
                    h264DisplayGateWaitTotalUs += gateWaitUs;
                    h264DisplayGateWaitMaxUs = Math.max(
                        h264DisplayGateWaitMaxUs,
                        gateWaitUs
                    );
                    h264DisplayPresentTotalUs += presentUs;
                    h264DisplayPresentMaxUs = Math.max(
                        h264DisplayPresentMaxUs,
                        presentUs
                    );
                }
                h264LastPresentationAtMs = presentedAtMs;
                h264PresentedSeq = telemetry.presentedSeq;
            }
            h264FirmwareFrames = Math.max(h264FirmwareFrames, telemetry.frames);
            h264FirmwareQueueCapacity = telemetry.version >= 3
                ? Math.max(1, telemetry.queueCapacity)
                : H264_STARTUP_WINDOW;
            h264FirmwareQueuedBytes = telemetry.version >= 3 ? telemetry.queuedBytes : 0;
        }

        h264MaxFirmwareQueueDepth =
            Math.max(h264MaxFirmwareQueueDepth, telemetry.queueDepth);

        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence > 0
                    && transfer.streamId == telemetry.streamId
                    && Integer.compareUnsigned(
                        transfer.sequence, telemetry.decodedSeq
                    ) <= 0) {

                if (isLeft) {
                    transfer.leftDecoderConfirmed = true;
                }

                if (isRight) {
                    transfer.rightDecoderConfirmed = true;
                }

                transfer.decoderConfirmed =
                    transfer.leftDecoderConfirmed &&
                    transfer.rightDecoderConfirmed;

                if (transfer.decoderConfirmed) {
                    transfer.terminal = true;
                    transfer.recoveryInProgress = false;
                    transfer.retryPending = false;
                    transfer.wireGeneration++;
                    cancelH264TransferMessagesLocked(
                        transfer.id,
                        "both decoders confirmed seq=" + transfer.sequence
                    );
                }
            }
        }
        purgeCompletedH264TransfersLocked();

        boolean sequenceError = (telemetry.flags & 8) != 0;
        boolean snapshotOverflow = (telemetry.flags & 16) != 0;
        boolean snapshotOom = (telemetry.flags & 32) != 0;
        boolean reorderWait = (telemetry.flags & 64) != 0;
        boolean queueFull = (telemetry.flags & 128) != 0;
        int decoderLag = Math.max(0, h264HighestQueuedSeq - telemetry.decodedSeq);
        String allocationFailure = h264AllocationFailure(telemetry);
        String arenaUsage = h264ArenaUsage(telemetry);
        logLine("H264STAT " + (isLeft ? "LEFT" : "RIGHT") + " addr=" + address + " fwside=" + telemetry.side + " session=" + unsignedInt(telemetry.streamId)
            + " rx=" + unsignedInt(telemetry.receivedSeq)
            + " dec=" + unsignedInt(telemetry.decodedSeq)
            + " present=" + unsignedInt(telemetry.presentedSeq)
            + " expected=" + unsignedInt(telemetry.expectedSeq)
            + " frames=" + telemetry.frames
            + " q=" + telemetry.queueDepth
            + "/" + h264FirmwareQueueCapacity
            + " qbytes=" + h264FirmwareQueuedBytes
            + " lag=" + decoderLag
            + " nal=" + telemetry.nalType
            + " result=" + telemetry.result
            + " decode=" + telemetry.decodeUs + "us"
            + " retries=" + h264RetryCount
            + (telemetry.version >= 4
                ? " diag=" + unsignedInt(telemetry.diagStage)
                    + "/" + unsignedInt(telemetry.diagMbEntered)
                    + "/" + unsignedInt(telemetry.diagMbCompleted)
                    + "/" + unsignedInt(telemetry.diagBitOffset)
                : "")
            + (telemetry.version == 12
                    && (telemetry.diagMbCompleted < 200
                        || telemetry.diagMbCompleted >= 500)
                ? " sync=" + telemetry.emptyDeferredCallbacks
                    + "/" + telemetry.backlogDeferredCallbacks
                : "")
            + (telemetry.version >= 13 && telemetry.result != 0xff
                ? " pace=" + telemetry.paceFired
                    + "/" + telemetry.paceScheduled
                    + (telemetry.version >= 16
                        ? " route=" + telemetry.paceDirect
                            + "/" + Math.max(
                                0,
                                telemetry.paceScheduled - telemetry.paceDirect
                            )
                        : "")
                    + " late=" + telemetry.paceLate
                    + " maxLate=" + telemetry.paceMaxLateMs + "ms"
                : "")
            + (telemetry.version >= 14 && telemetry.result != 0xff
                ? " gate=" + unsignedInt(telemetry.displayGateWaitUs) + "us"
                    + " presentWork=" + unsignedInt(telemetry.displayPresentUs) + "us"
                : "")
            + (allocationFailure != null
                ? " ALLOCFAIL=" + allocationFailure
                    + " bytes=" + unsignedInt(telemetry.diagBitOffset)
                : "")
            + (arenaUsage != null ? " " + arenaUsage : "")
            + (sequenceError ? " SEQERR" : "")
            + (snapshotOverflow ? " SNAPOF" : "")
            + (snapshotOom ? " SNAPOOM" : "")
            + (reorderWait ? " REORDERWAIT" : "")
            + (queueFull ? " QFULL" : ""));

        if (allocationFailure != null) {
            failH264StreamLocked(
                "firmware decoder allocation failed: " + allocationFailure
                    + " bytes=" + unsignedInt(telemetry.diagBitOffset)
                    + (arenaUsage != null ? " " + arenaUsage : "")
            );
        } else if (snapshotOom) {
            failH264StreamLocked("firmware H264 snapshot allocation failed");
        } else if (snapshotOverflow && telemetry.version < 3) {
            failH264StreamLocked("firmware snapshot overflow");
        } else if (h264Streaming) {
            if (queueFull) {
                H264Transfer rejected = findH264TransferBySequenceLocked(
                    telemetry.receivedSeq
                );
                if (rejected != null && !rejected.recoveryInProgress) {
                    rejected.retryPending = true;
                    rejected.confirmationDeadlineMs = 0;
                    logLine("H264 firmware queue rejected seq="
                        + unsignedInt(rejected.sequence)
                        + "; retry deferred until it is expected");
                }
            }
            if (sequenceError) {
                H264Transfer expected = findH264TransferBySequenceLocked(telemetry.expectedSeq);
                if (expected == null) {
                    failH264StreamLocked(
                        "firmware requested unavailable seq=" + telemetry.expectedSeq
                    );
                } else {
                    if (!expected.recoveryInProgress
                            && !retryH264TransferLocked(
                                expected,
                                "firmware requested expected sequence"
                            )) {
                        failH264TransferLocked(
                            expected,
                            "firmware sequence recovery unavailable"
                        );
                    } else if (expected.recoveryInProgress) {
                        logLine("H264 recovery waiting seq="
                            + unsignedInt(expected.sequence));
                    }
                }
            }
        }
        lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
        if (h264Streaming && !h264StreamFailed) {
            checkH264ConfirmationDeadlinesLocked();
        }
        lock.notifyAll();
    }

    private H264Transfer findH264TransferBySequenceLocked(int sequence) {
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal && transfer.sequence == sequence) return transfer;
        }
        return null;
    }

    private void failH264StreamLocked(String reason) {
        h264StreamFailed = h264Streaming;
        for (H264Transfer transfer : h264Transfers) {
            if (!transfer.terminal) {
                transfer.failed = true;
                transfer.terminal = true;
                transfer.wireGeneration++;
                cancelH264TransferMessagesLocked(transfer.id, "H264 stream failed: " + reason);
            }
        }
        logLine("H264 stream failed: " + reason);
        lock.notifyAll();
    }

    private static H264Telemetry parseH264Telemetry(BleProtocol.ParsedFrame frame) {
        if (frame == null || !frame.ok || frame.sid != 0x11
                || (frame.flag != BleProtocol.FLAG_NOTIFY && frame.flag != BleProtocol.FLAG_NOTIFY_ALT)) {
            return null;
        }
        byte[] pb = frame.pb;
        for (int i = 0; i + 2 < pb.length; i++) {
            if ((pb[i] & 0xff) != 0xa2 || (pb[i + 1] & 0xff) != 0x06) continue;
            int len = pb[i + 2] & 0xff;
            int o = i + 3;
            if (len < 28 || o + len > pb.length || pb[o] != 'H' || pb[o + 1] != '2') return null;
            H264Telemetry result = new H264Telemetry();
            result.version = pb[o + 2] & 0xff;
            result.side = pb[o + 3] & 0xff;
            result.flags = pb[o + 4] & 0xff;
            result.queueDepth = pb[o + 5] & 0xff;
            result.nalType = pb[o + 6] & 0xff;
            result.result = pb[o + 7] & 0xff;
            if (result.version >= 2 && len >= 36) {
                result.streamId = readLe32(pb, o + 8);
                result.receivedSeq = readLe32(pb, o + 12);
                result.decodedSeq = readLe32(pb, o + 16);
                result.presentedSeq = readLe32(pb, o + 20);
                result.frames = readLe32(pb, o + 24);
                result.decodeUs = readLe32(pb, o + 28);
                result.expectedSeq = readLe32(pb, o + 32);
                if (result.version >= 3 && len >= 41) {
                    result.queueCapacity = pb[o + 36] & 0xff;
                    result.queuedBytes = readLe32(pb, o + 37);
                } else {
                    result.queueCapacity = H264_STARTUP_WINDOW;
                    result.queuedBytes = 0;
                }
                if (result.version >= 4 && len >= 57) {
                    result.diagStage = readLe32(pb, o + 41);
                    result.diagMbEntered = readLe32(pb, o + 45);
                    result.diagMbCompleted = readLe32(pb, o + 49);
                    result.diagBitOffset = readLe32(pb, o + 53);
                    if (result.version >= 16 && result.result != 0xff) {
                        result.paceScheduled = result.diagStage & 0x3ff;
                        result.paceFired = (result.diagStage >>> 10) & 0x3ff;
                        result.paceDirect = (result.diagStage >>> 20) & 0x3ff;
                        result.paceLate = result.diagMbEntered & 0x3ff;
                        result.paceMaxLateMs =
                            (result.diagMbEntered >>> 10) & 0x3ff;
                        result.displayGateWaitUs = result.diagMbCompleted;
                        result.displayPresentUs = result.diagBitOffset;
                    } else if (result.version >= 14 && result.result != 0xff) {
                        result.paceScheduled = result.diagStage & 0xffff;
                        result.paceFired = (result.diagStage >>> 16) & 0xffff;
                        result.paceLate = result.diagMbEntered & 0xffff;
                        result.paceMaxLateMs =
                            (result.diagMbEntered >>> 16) & 0xffff;
                        result.displayGateWaitUs = result.diagMbCompleted;
                        result.displayPresentUs = result.diagBitOffset;
                    } else if (result.version >= 13 && result.result != 0xff) {
                        result.paceScheduled = result.diagStage;
                        result.paceFired = result.diagMbEntered;
                        result.paceLate = result.diagMbCompleted;
                        result.paceMaxLateMs = result.diagBitOffset;
                    } else if (result.version >= 12
                            && (result.diagMbCompleted < 200
                                || result.diagMbCompleted >= 500)) {
                        result.emptyDeferredCallbacks =
                            result.diagBitOffset & 0xffff;
                        result.backlogDeferredCallbacks =
                            (result.diagBitOffset >>> 16) & 0xffff;
                    }
                }
            } else {
                result.receivedSeq = readLe32(pb, o + 8);
                result.decodedSeq = readLe32(pb, o + 12);
                result.presentedSeq = readLe32(pb, o + 16);
                result.frames = readLe32(pb, o + 20);
                result.decodeUs = readLe32(pb, o + 24);
            }
            return result;
        }
        return null;
    }

    private static String h264AllocationFailure(H264Telemetry telemetry) {
        if (telemetry == null || telemetry.version < 5) return null;
        if (telemetry.version >= 13 && telemetry.result != 0xff) return null;
        int stage = telemetry.diagMbCompleted;
        if (telemetry.version >= 7 && stage == 290) {
            switch (telemetry.diagBitOffset) {
                case 1: return "arena-bind-invalid-layout";
                case 2: return "arena-bind-runtime-mismatch";
                case 3: return "arena-bind-used-overflow";
                default: return "arena-bind-failed";
            }
        }

        int family = stage / 100;
        int tag = stage % 100;
        if (family < 1 || family > 4) return null;
        String reason;
        switch (family) {
            case 2: reason = " arena-unavailable"; break;
            case 3: reason = " arena-exhausted"; break;
            case 4: reason = " firmware-heap-exhausted"; break;
            default: reason = ""; break;
        }
        String allocation;
        switch (tag) {
            case 1: allocation = "dpb-entries"; break;
            case 2: allocation = "frame-y"; break;
            case 3: allocation = "frame-u"; break;
            case 4: allocation = "frame-v"; break;
            case 5: allocation = "nnz-luma"; break;
            case 6: allocation = "nnz-cb"; break;
            case 7: allocation = "nnz-cr"; break;
            case 8: allocation = "mb-qps"; break;
            case 9: allocation = "mb-transform8x8"; break;
            case 10: allocation = "mb-motion"; break;
            case 11: allocation = "mb-intra4x4-modes"; break;
            case 12: allocation = "cabac-neighbors"; break;
            default: return null;
        }
        return allocation + reason;
    }

    private static String h264ArenaUsage(H264Telemetry telemetry) {
        if (telemetry == null || telemetry.version < 7) return null;
        if (telemetry.version >= 13 && telemetry.result != 0xff) return null;
        int stage = telemetry.diagMbCompleted;
        if (stage < 200 || stage >= 500) return null;
        long firstSize = (telemetry.diagStage & 0xffffL) * 8L;
        long firstUsed = ((telemetry.diagStage >>> 16) & 0xffffL) * 8L;
        long secondSize = (telemetry.diagMbEntered & 0xffffL) * 8L;
        long secondUsed = ((telemetry.diagMbEntered >>> 16) & 0xffffL) * 8L;
        return "arena=A:" + firstUsed + "/" + firstSize
            + " B:" + secondUsed + "/" + secondSize;
    }

    private static int readLe32(byte[] bytes, int offset) {
        return (bytes[offset] & 0xff)
            | ((bytes[offset + 1] & 0xff) << 8)
            | ((bytes[offset + 2] & 0xff) << 16)
            | ((bytes[offset + 3] & 0xff) << 24);
    }

    private static String unsignedInt(int value) {
        return Integer.toUnsignedString(value);
    }

    private void handleDirectRingNotification(String characteristicUuid, byte[] data) {
        FaceclawRingEventDecoder.DirectRingEvent decoded = FaceclawRingEventDecoder.decode(data);
        if (decoded == null) {
            Log.d(TAG, "direct ring notify ignored: characteristicUuid=" + characteristicUuid + " raw=" + hex(data));
            return;
        }

        G2Event event = decoded.event;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
            lastConnectionOrInputAtMs = arrivalMs;
        }
        logLine("direct ring " + decoded.label + " " + decoded.detail + " raw=" + hex(data));
        int frameId = FrameTimings.getInstance().startFrame("input:ring:" + decoded.label);
        FrameTimings.getInstance().log(frameId, "input event decoded from direct ring notification");
        emitRingEvent(event.kind, event.containerName, event.eventType, event.eventSource, event.systemExitReasonCode, frameId);
        interruptibleSleep.interrupt();
    }

    private void handleRenderNotification(String address, byte[] data) {
        FaceclawAudioPacketListener listenerToCall;
        long arrivalMs = SystemClock.elapsedRealtime();
        synchronized (lock) {
            lastIncomingAtMs = arrivalMs;
            listenerToCall = audioCaptureActive ? audioPacketListener : null;
        }
        if (listenerToCall == null) {
            return;
        }
        String arm = address.equalsIgnoreCase(leftAddress) ? "L" : address.equalsIgnoreCase(rightAddress) ? "R" : "?";
        try {
            listenerToCall.onAudioPacket(Arrays.copyOf(data, data.length), arm, arrivalMs);
        } catch (Throwable t) {
            logLine("G2 mic packet listener failed: " + safeMessage(t));
        }
    }

    @Override public void onConnectionStateChange(String address, boolean connected) {
        synchronized (lock) {
            if (address == null) {
                return;
            }
            if (isConfiguredRingAddress(address)) {
                ringConnected = connected;
                ringNotificationsReady = false;
                if (!connected) {
                    ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS;
                }
                logLine(connected ? "direct ring BLE connected" : "direct ring BLE disconnected");
                return;
            }
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = connected;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = connected;
            } else {
                return;
            }
            if (!connected) {
                sessionReady = false;
                fixedLayoutCreated = false;
                warmedUp = false;
                startupProbePending = false;
                chargingMode = false;
                audioCaptureActive = false;
                audioPacketListener = null;
                clearAllMessagesLocked("connection lost");
                displayedFingerprint = "";
                reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
            }
        }
        interruptibleSleep.interrupt();
        if (connected) {
            setStateDisplay("connected", "Connected.");
        } else {
            setStateDisplay("connecting", "Connecting to the glasses...");
        }
    }

    private void connectLoopOnce() throws InterruptedException {
        setStateDisplay("connecting", "Connecting to the glasses...");
        try {
            connectArm(rightAddress, true);
            connectArm(leftAddress, true);
            if (!sleepDuringConnectSettling(800)) {
                return;
            }
            sendPrelude();

            synchronized (lock) {
                sessionReady = true;
                // A fresh transport prelude always starts an active EvenHub
                // lifecycle, even if the previous connection dropped while
                // its page was intentionally suspended.
                shutdownRequested = false;
                fixedLayoutCreated = false;
                warmedUp = false;
                clearAllMessagesLocked("session ready");
                displayedFingerprint = "";
                lastAckAtMs = SystemClock.elapsedRealtime();
                lastIncomingAtMs = lastAckAtMs;
                lastConnectionOrInputAtMs = lastAckAtMs;
                lastSessionReadyAtMs = lastAckAtMs;
                lastBatteryRefreshAtMs = 0;
                imageRetryAfterMs = 0;
                lastHeartbeatSentAtMs = 0;
                lastHeartbeatAckedAtMs = 0;
                consecutiveAckTimeouts = 0;
                lastAudioControlAckMagic = 0;
                audioCaptureActive = false;
                faceclawWakePendingNonce = -1;
                lastFaceclawWakeLeaseQueuedAtMs = 0;
                lastFaceclawFramebufferLeaseQueuedAtMs = 0;
                enqueueFaceclawFramebufferControlLocked(
                    BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                    true
                );
                if (faceclawWakeLeaseEnabled) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        true
                    );
                }
            }
            setStateDisplay("connected", "Connected.");
            logLine("session ready");
        enableWearDetectionAndRequestState();
            synchronized (lock) {
                // Query settings promptly on the first session so firmware
                // version/capabilities (and battery) arrive without waiting for
                // the input-quiet battery poll. The settings response doubles as
                // the firmware-compatibility check surfaced during onboarding.
                if (!firmwareInfoQueried) {
                    firmwareInfoQueried = true;
                    lastBatteryRefreshAtMs = SystemClock.elapsedRealtime();
                    pendingMessages.addLast(createBatteryQueryMessageLocked());
                    logLine("queue settings query for firmware info");
                }
            }
            tryConnectRing("initial");
        } catch (Throwable t) {
            logLine("connect failed: " + safeMessage(t));
            handleTransportFailure("connect failed");
        }
    }

    private boolean sleepDuringConnectSettling(long delayMs) throws InterruptedException {
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        synchronized (lock) {
            while (running && !userDisconnectRequested) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return true;
                }
                lock.wait(Math.min(remaining, 100));
            }
            return false;
        }
    }

    private void connectArm(String address, boolean enableRenderNotify) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        // requestConnectionPriority has no callback in this Android compile target, so there is
        // no reliable completion point to keep it in the global GATT operation pipeline. But it's
        // important enough for performance that we call it anyways.
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);

        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);

        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address + " " + BleProtocol.NOTIFY_CHAR_UUID);
        }
        if (enableRenderNotify) {
            bleManager.enableNotifications(address, BleProtocol.RENDER_NOTIFY_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS);
        }
        bleManager.readPhy(address);
        synchronized (lock) {
            if (address.equalsIgnoreCase(rightAddress)) {
                rightConnected = true;
            } else if (address.equalsIgnoreCase(leftAddress)) {
                leftConnected = true;
            }
        }
    }

    private boolean shouldAttemptRingConnect() {
        if (!hasRingAddress()) {
            return false;
        }
        long now = SystemClock.elapsedRealtime();
        synchronized (lock) {
            return running
                && sessionReady
                && !ringNotificationsReady
                && now >= ringReconnectAfterMs
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty();
        }
    }

    private void tryConnectRing(String reason) {
        if (!hasRingAddress()) {
            return;
        }
        try {
            connectRing();
        } catch (Throwable t) {
            synchronized (lock) {
                ringConnected = false;
                ringNotificationsReady = false;
                ringReconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RING_RECONNECT_DELAY_MS;
            }
            logLine("direct ring connect failed (" + reason + "): " + safeMessage(t));
        }
    }

    private void connectRing() {
        logLine("connecting direct ring " + ringAddress);
        if (!bleManager.connect(ringAddress, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + ringAddress);
        }

        bleManager.requestConnectionPriority(ringAddress, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(ringAddress, ConnectionOptions.RING_DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);

        if (!bleManager.discoverServices(ringAddress, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + ringAddress);
        }

        boolean phoneNotify = enableRingNotification(BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID);
        boolean dataNotify = enableRingNotification(BleProtocol.R1_NOTIFY_CHAR_UUID);
        if (!phoneNotify && !dataNotify) {
            throw new IllegalStateException("no R1 notify characteristic subscribed");
        }

        synchronized (lock) {
            ringConnected = true;
            ringNotificationsReady = true;
            ringReconnectAfterMs = 0;
        }
        logLine("direct ring ready phoneNotify=" + phoneNotify + " dataNotify=" + dataNotify);
    }

    private boolean enableRingNotification(String characteristicUuid) {
        try {
            return bleManager.enableNotifications(
                ringAddress,
                characteristicUuid,
                true,
                ConnectionOptions.DESCRIPTOR_TIMEOUT_MS
            );
        } catch (Throwable t) {
            Log.d(TAG, "direct ring notify subscribe skipped: " + characteristicUuid + " " + safeMessage(t));
            return false;
        }
    }

    private void sendPrelude() throws InterruptedException {
        sendPrelude(false);
    }

    private void sendPrelude(boolean preserveWakeLeaseControls) throws InterruptedException {
        synchronized (lock) {
            if (preserveWakeLeaseControls) {
                clearAllMessagesPreservingWakeLeaseLocked("prelude");
            } else {
                clearAllMessagesLocked("prelude");
            }
        }
        long now = SystemClock.elapsedRealtime();
        OutboundMessage prelude = messageBuilder.prelude();
        prelude.onAck = () -> {
        };
        prelude.onTimeout = () -> {
            handleTransportFailure("ack timeout");
        };
        prelude.sentAtMs = now;
        writeMessage(prelude);

        long deadline = SystemClock.elapsedRealtime() + ConnectionOptions.PRELUDE_TIMEOUT_MS;
        while (running && !userDisconnectRequested && !inFlightMessages.isEmpty()) {
            synchronized (lock) {
                if (!running || userDisconnectRequested || inFlightMessages.isEmpty()) {
                    break;
                }
            }
            long remaining = deadline - SystemClock.elapsedRealtime();
            if (remaining <= 0) {
                break;
            }
            interruptibleSleep.sleep(Math.min(remaining, 100));
        }
        synchronized (lock) {
            if (!inFlightMessages.isEmpty()) {
                clearInFlightMessagesLocked("prelude timeout");
                throw new IllegalStateException("prelude ack timeout");
            }
        }
    }

    private long driveSession() {
        //Log.d(TAG, "driveSession called (pendingMessages.size=" + pendingMessages.size() + " inFlightMessages.size=" + inFlightMessages.size() + ")");
        while (true) {
            OutboundMessage messageToWrite = null;
            OutboundMessage messageToPrewrite = null;
            long now = SystemClock.elapsedRealtime();

            maybeFinishNoChangeDesiredFrame();

            synchronized (lock) {
                if (sessionReady
                        && now - lastFaceclawFramebufferLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("framebuffer-lease-control")) {
                    enqueueFaceclawFramebufferControlLocked(
                        BleProtocol.FACECLAW_FB_OP_ACQUIRE,
                        false
                    );
                }
                if (faceclawWakeLeaseEnabled
                        && sessionReady
                        && now - lastFaceclawWakeLeaseQueuedAtMs >= FACECLAW_WAKE_LEASE_RENEW_MS
                        && !hasPendingOrInflightKindLocked("wake-lease-control")) {
                    enqueueFaceclawWakeControlLocked(
                        BleProtocol.FACECLAW_WAKE_OP_ACQUIRE,
                        0,
                        false
                    );
                }
                if (!inFlightMessages.isEmpty()) {
                    OutboundMessage oldest = inFlightMessages.peekFirst();
                    if (oldest != null && oldest.ackDeadlineAtMs <= now) {
                        Log.i(TAG, "message timed out: " + oldest.label);
                        inFlightMessages.removeFirst();
                        logLine("message timed out: " + oldest.label);
                        magicPool.release(oldest.sid, oldest.magic, oldest.label, "timeout");
                        handleAckTimeoutLocked(oldest);
                        return 0;
                    }
                    if ((!h264Streaming || H264_BLE_WINDOW <= 1)
                            && connectionOptions.WINDOW_SIZE <= 1
                            && sessionReady
                            && prewrittenMessage == null
                            && !pendingMessages.isEmpty()
                            && canPrewriteCandidate(pendingMessages.peekFirst())
                            && !shouldBlockPrewriteForHeartbeatLocked(now)) {
                        // Only the serial (window==1) path pre-sends the all-but-last
                        // packet; with a real window we just send the next message fully.
                        messageToPrewrite = pendingMessages.peekFirst();
                    }
                }

                if (chargingMode) {
                    // Glasses are in the case: no display traffic, only battery
                    // polls (which also detect the end of charging).
                    finishDesiredFrameLocked("discarded: glasses charging");
                    if (sessionReady && inFlightMessages.isEmpty() && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message (charging): " + messageToWrite.label);
                    } else if (sessionReady && pendingMessages.isEmpty() && inFlightMessages.isEmpty()
                            && now - lastBatteryRefreshAtMs >= ConnectionOptions.CHARGING_BATTERY_POLL_MS) {
                        Log.i(TAG, "Writing charging-mode battery poll");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else {
                        return 1_000;
                    }
                } else {
                    if (messageToPrewrite == null
                            && !shutdownRequested
                            && !fixedLayoutCreated
                            && pendingMessages.isEmpty()
                            && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing create layout");
                        enqueueCreateLayoutLocked();
                    } else if (messageToPrewrite != null) {
                        // Prewrite outside the lock; the logical message remains pending until
                        // its final BLE frame is sent after the current protocol ACK.
                    }
                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && !warmedUp && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing warmup");
                        enqueueWarmupLocked();
                    }

                    if (messageToPrewrite == null && !h264Streaming && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && (firmwareDebugFlagsEnabled ? 2 : 1) != firmwareDebugFlagsLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing firmware debug flags " + (firmwareDebugFlagsEnabled ? "show" : "hide"));
                        enqueueFirmwareDebugFlagsLocked();
                    }

                    if (messageToPrewrite == null && !h264Streaming && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && (compassEnabled ? 1 : 0) != compassControlLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing compass " + (compassEnabled ? "enable" : "disable"));
                        enqueueCompassControlLocked(false, compassEnabled);
                    }

                    // Ordinary UI traffic uses the configured transport window.
                    // H.264 keeps its separate four-NAL logical decoder window,
                    // but serializes physical BLE messages so completed images
                    // reach both lenses at an even cadence instead of bursts of
                    // three followed by a queue-drain pause.
                    int transportWindow = h264Streaming
                        ? H264_BLE_WINDOW
                        : Math.max(1, connectionOptions.WINDOW_SIZE);
                    boolean windowHasRoom = inFlightMessages.size() < transportWindow;
                    // A frame ready to send right now: don't inject a fresh
                    // heartbeat in front of it (the image's own ack resets the
                    // firmware heartbeat timer, so the heartbeat is redundant).
                    boolean imageWaiting = !h264Streaming && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && !hasPendingOrInflightKindLocked("heartbeat")
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint);
                    if (messageToPrewrite == null && !h264Streaming && handleHeartbeat(imageWaiting)) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    }

                    if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message: " + messageToWrite.label);
                    } else if (messageToPrewrite == null && !h264Streaming && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && windowHasRoom && !hasPendingImageLocked()
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint)) {
                        // Enqueue the next frame's delta against lastEnqueuedPacked
                        // (what the shadow will be), so it can pipeline behind an
                        // image still awaiting its ack.
                        Log.i(TAG, "Enqueued image update");
                        enqueueDesiredImageLocked();
                        return 0;
                    } else if (messageToPrewrite == null && !h264Streaming && shouldPollBatteryLocked(now)) {
                        Log.i(TAG, "Writing battery query");
                        messageToWrite = createBatteryQueryMessageLocked();
                        lastBatteryRefreshAtMs = now;
                    } else if (messageToPrewrite == null && (!pendingMessages.isEmpty() || !inFlightMessages.isEmpty())) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    } else if (messageToPrewrite == null) {
                        return 250;
                    }
                }
            }

            if (messageToPrewrite != null) {
                if (prewriteMessage(messageToPrewrite)) {
                    return 0;
                }
                return ConnectionOptions.IDLE_SLEEP_MS;
            }

            if (!writeMessage(messageToWrite)) {
                synchronized (lock) {
                    if (removePreparedMessageLocked(messageToWrite) || messageToWrite.magic == 0) {
                        handleTransportFailure("write failed");
                    }
                }
                return 0;
            }
        }
    }

    /**
     * If the desired image already matches what the glasses display, nothing will
     * ever be enqueued for it, so finish its frame now (otherwise the TS side
     * would block on it until its backpressure timeout).
     */
    private void maybeFinishNoChangeDesiredFrame() {
        int frameIdToFinish = 0;
        synchronized (lock) {
            synchronized (desiredTilesLock) {
                if (desiredFrameId != 0 && !lastEnqueuedFingerprint.isEmpty() && desiredFingerprint.equals(lastEnqueuedFingerprint)) {
                    frameIdToFinish = desiredFrameId;
                    desiredFrameId = 0;
                }
            }
        }
        if (frameIdToFinish != 0) {
            finishFrame(frameIdToFinish, "discarded: no change from displayed image");
        }
    }

    private boolean shouldBlockPrewriteForHeartbeatLocked(long now) {
        if (shutdownRequested || !warmedUp || !fixedLayoutCreated) {
            return false;
        }
        return hasPendingOrInflightKindLocked("heartbeat")
                || now - lastHeartbeatAckedAtMs >= ConnectionOptions.HEARTBEAT_READY_MS;
    }

    private boolean canPrewriteCandidate(OutboundMessage message) {
        if (message == null || !message.isLeftArmMessage) {
            return false;
        }
        if (!"image".equals(message.kind) && !"warmup".equals(message.kind)) {
            return false;
        }
        return message.message.length + 2 > 232;
    }

    private boolean handleHeartbeat(boolean imageWaiting) {
        long now = SystemClock.elapsedRealtime();
        boolean heartbeatEligible = !shutdownRequested && warmedUp && fixedLayoutCreated;
        boolean heartbeatPending = heartbeatEligible && hasPendingOrInflightKindLocked("heartbeat");
        long heartbeatElapsedMs = now - lastHeartbeatAckedAtMs;
        boolean heartbeatReady = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_READY_MS;
        boolean heartbeatUrgent = heartbeatEligible && heartbeatElapsedMs >= ConnectionOptions.HEARTBEAT_URGENT_MS;
        boolean heartbeatBlocksLeftWrites = heartbeatReady || heartbeatPending;

        if (heartbeatReady && !heartbeatPending && inFlightMessages.isEmpty()) {
            if (imageWaiting && !heartbeatUrgent) {
                // Defer to the waiting frame: sending it now satisfies the
                // firmware heartbeat deadline (its ack resets the timer), and
                // the heartbeat still fires once we reach the URGENT threshold
                // if rendering goes quiet again. Preserves the pending-heartbeat
                // inter-lens-sync invariant below (that path is untouched).
                return false;
            }
            Log.i(TAG, "Writing heartbeat");
            OutboundMessage heartbeatMessage = createHeartbeatMessage();
            lastHeartbeatSentAtMs = now;
            writeMessage(heartbeatMessage);
            return true;
        } else if (heartbeatUrgent) {
            return true;
        } else if (heartbeatPending) {
            // Don't send other message types while a heartbeat is pending because that
            // can lead to inter-lens sync issues
            return true;
        }

        return false;
    }

    private OutboundMessage createHeartbeatMessage() {
        OutboundMessage message = messageBuilder.heartbeat();
        message.onAck = () -> {
            synchronized (lock) {
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            }
        };
        message.onTimeout = () -> {
            // If a heartbeat fails to ack and we're over the heartbeat deadline, assume the connection is failed and reconnect.
            // Otherwise ignore it, which will cause a retransmission attempt.
            boolean isPastDeadline;
            synchronized (lock) {
                isPastDeadline = SystemClock.elapsedRealtime() - lastHeartbeatSentAtMs >= ConnectionOptions.HEARTBEAT_FAILURE_DEADLINE_MS;
            }
            if (isPastDeadline) {
                handleTransportFailure("heartbeat ack timeout");
            }
        };
        return message;
    }


    private boolean writeMessage(OutboundMessage message) {
        long now = SystemClock.elapsedRealtime();
        message.writeStartedAtMs = now;
        message.sentAtMs = now;
        message.ackDeadlineAtMs = now + message.ackTimeoutMs + ConnectionOptions.WRITE_TIMEOUT_MS;
        synchronized (lock) {
            if (message.h264Payload && !isCurrentH264MessageLocked(message)) {
                message.cancelled = true;
                discardPrewriteIfMatchesLocked(message);
                magicPool.release(
                    message.sid,
                    message.magic,
                    message.label,
                    "stale H264 generation before write"
                );
                return true;
            }
            if (message.magic != 0) {
                inFlightMessages.addLast(message);
            }
        }
        if (message.imageUpdateId > 0 && message.imageMessageNumber == 1) {
            synchronized(lock) {
                BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
                if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                    stats.firstWriteStartedAtMs = now;
                }
            }
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> frames;
        if (prewrittenMessage != null && prewrittenMessage != message) {
            if (!spoilPrewrittenMessage("before " + message.label)) {
                return false;
            }
        }
        if (prewrittenMessage == message) {
            frames = Collections.singletonList(prewrittenFrames.get(prewrittenFrames.size() - 1));
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
        } else {
            frames = BleProtocol.framePb(
                message.message,
                message.sid,
                message.flag,
                nextTransportSeq++
            );
        }
        long h264PhyWriteStartedAtMs = SystemClock.elapsedRealtime();
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
        if (message.h264Payload) {             long h264PhyWriteMs = Math.max(                 0L,                 SystemClock.elapsedRealtime() - h264PhyWriteStartedAtMs             );             Log.i(TAG, "H264PHY WRITE transfer=" + message.h264TransferId                 + " generation=" + message.h264Generation                 + " arm=" + (message.isLeftArmMessage ? "L" : "R")                 + " sid=" + message.sid                 + " magic=" + message.magic                 + " frames=" + frames.size()                 + " writeMs=" + h264PhyWriteMs                 + " result=" + result);         }

        synchronized (lock) {
            long sentAtMs = SystemClock.elapsedRealtime();
            message.sentAtMs = sentAtMs;
            message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs;
            logImageUpdateSendLandmarkLocked(message);
            boolean current = !message.h264Payload || isCurrentH264MessageLocked(message);
            if (result && current && message.onSent != null) {
                message.onSent.run();
                lock.notifyAll();
            }
        }

        return result;
    }

    private boolean prewriteMessage(OutboundMessage message) {
        synchronized (lock) {
            if (message.h264Payload && !isCurrentH264MessageLocked(message)) {
                message.cancelled = true;
                discardPrewriteIfMatchesLocked(message);
                magicPool.release(
                    message.sid,
                    message.magic,
                    message.label,
                    "stale H264 generation before prewrite"
                );
                return true;
            }
        }
        if (prewrittenMessage == message) {
            return true;
        }
        if (prewrittenMessage != null && !spoilPrewrittenMessage("before prewrite " + message.label)) {
            return false;
        }
        if (!canPrewriteCandidate(message)) {
            return false;
        }

        List<byte[]> frames = BleProtocol.framePb(
            message.message,
            message.sid,
            message.flag,
            nextTransportSeq++
        );
        if (frames.size() <= 1) {
            return false;
        }

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        List<byte[]> prefixFrames = frames.subList(0, frames.size() - 1);
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            prefixFrames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
        if (!result) {
            return false;
        }

        prewrittenMessage = message;
        prewrittenFrames = new ArrayList<>(frames);
        logLine("prewrote " + message.label + " frames=" + prefixFrames.size() + "/" + frames.size());
        return true;
    }

    private boolean spoilPrewrittenMessage(String reason) {
        if (prewrittenMessage == null || prewrittenFrames.isEmpty()) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
            return true;
        }
        OutboundMessage message = prewrittenMessage;
        byte[] finalFrame = Arrays.copyOf(
            prewrittenFrames.get(prewrittenFrames.size() - 1),
            prewrittenFrames.get(prewrittenFrames.size() - 1).length
        );
        if (finalFrame.length > 8) {
            finalFrame[finalFrame.length - 1] ^= (byte) 0xff;
        }
        prewrittenMessage = null;
        prewrittenFrames = Collections.emptyList();

        String writeAddress = message.isLeftArmMessage ? leftAddress : rightAddress;
        logLine("spoiling prewritten " + message.label + ": " + reason);
        return bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            Collections.singletonList(finalFrame),
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );
    }

    private boolean removePreparedMessageLocked(OutboundMessage message) {
        if (message == null || message.magic == 0) {
            return false;
        }
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            if (iterator.next() == message) {
                iterator.remove();
                magicPool.release(message.sid, message.magic, message.label, "write failed");
                return true;
            }
        }
        return false;
    }


    private void resolveAckLocked(int sid, int magic, byte[] pb) {
        Iterator<OutboundMessage> iterator = inFlightMessages.iterator();
        while (iterator.hasNext()) {
            OutboundMessage message = iterator.next();
            if (message.sid == sid && message.magic == magic) {
                resolveAckLocked(message, pb);
                return;
            }
        }
        recordUnexpectedAckLocked(sid, magic);
    }

    private void resolveAckLocked(OutboundMessage message, byte[] pb) {
        Log.i(TAG, "Got ACK for " + message.label + "(sid=" + message.sid + ", id=" + message.magic + ")");
        inFlightMessages.remove(message);
        message.ackPayload = pb == null ? new byte[0] : Arrays.copyOf(pb, pb.length);
        magicPool.release(message.sid, message.magic, message.label, "ack");
        if (message.onAck != null) {
            message.onAck.run();
        }
        consecutiveAckTimeouts = 0;
        // ACK-specific waiters update their condition state in onAck. Wake them
        // immediately instead of making them consume the 100 ms safety poll.
        lock.notifyAll();
    }

    private void logImageUpdateSendLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.get(message.imageUpdateId);
        int frameId = stats == null ? 0 : stats.frameId;
        if (message.imageMessageNumber == 1) {
            if (stats != null && stats.firstWriteStartedAtMs <= 0) {
                stats.firstWriteStartedAtMs = message.writeStartedAtMs > 0 ? message.writeStartedAtMs : message.sentAtMs;
            }
            FrameTimings.getInstance().log(frameId, "first bluetooth packet sent");
            logImageUpdateLandmarkLocked("first bluetooth message sent", message, message.sentAtMs);
        }
        if (message.imageMessageNumber == message.imageMessageCount) {
            FrameTimings.getInstance().log(frameId,
                "last bluetooth packet sent (message " + message.imageMessageNumber + "/" + message.imageMessageCount + ")");
            logImageUpdateLandmarkLocked("last bluetooth message sent", message, message.sentAtMs);
        }
    }

    private void logImageUpdateAckLandmarkLocked(OutboundMessage message) {
        if (message.imageUpdateId <= 0 || message.imageMessageNumber != message.imageMessageCount) {
            return;
        }
        long ackedAtMs = SystemClock.elapsedRealtime();
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(message.imageUpdateId);
        if (stats != null && stats.firstWriteStartedAtMs > 0) {
            emitFrameMetrics(stats.paintMs, (int) Math.max(0, ackedAtMs - stats.firstWriteStartedAtMs), stats.tileCount);
        }
        if (stats != null) {
            finishFrame(stats.frameId, "sent");
        }
        logImageUpdateLandmarkLocked("last bluetooth message acked", message, ackedAtMs);
    }

    /** Remove the stats entry for an image update that will not complete, finishing its frame. */
    private void discardImageUpdateStatsLocked(int imageUpdateId, String reason) {
        if (imageUpdateId <= 0) {
            return;
        }
        BleImageOptimizer.ImageUpdateStats stats = imageUpdateStats.remove(imageUpdateId);
        if (stats != null) {
            finishFrame(stats.frameId, "discarded: " + reason);
        }
    }

    private void logImageUpdateLandmarkLocked(String event, OutboundMessage message, long elapsedMs) {
        logLine("image update#" + message.imageUpdateId + " " + event
                + " at " + timestamp(elapsedMs)
                + " message=" + message.imageMessageNumber + "/" + message.imageMessageCount
                + " label=" + message.label);
    }

    private void enqueueCreateLayoutLocked() {
        // New session/container: re-assert the firmware-debug-flags overlay once it's
        // warmed up again (the mode-7 send is gated on this having reset).
        firmwareDebugFlagsLastSent = -1;
        OutboundMessage message = messageBuilder.createLayout(DASHBOARD_TILE);
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("startup-text-probe");
            fixedLayoutCreated = true;
            displayedFingerprint = "";
        };
        message.onTimeout = () -> {
            if (startupProbePending) {
                logLine("create layout timed out while startup text probe is pending");
                if (hasPendingOrInflightKindLocked("startup-text-probe")) {
                    return;
                }
                startupProbePending = false;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
        logLine("queue create layout");
    }

    private void enqueueStartupProbeLocked() {
        enqueueCreateLayoutLocked();

        OutboundMessage message = messageBuilder.startupTextProbe();
        message.onAck = () -> {
            startupProbePending = false;
            clearMessagesOfKindLocked("create-layout");
            fixedLayoutCreated = true;
            warmedUp = false;
            displayedFingerprint = "";
            logLine("existing dashboard layout accepted text probe; image warmup still required");
        };
        message.onTimeout = () -> {
            startupProbePending = false;
            if (hasPendingOrInflightKindLocked("create-layout")) {
                return;
            }
            handleTransportFailure("ack timeout");
        };
        pendingMessages.addLast(message);
        startupProbePending = true;
        logLine("queue startup text probe");
    }

    private void enqueueWarmupLocked() {
        BleProtocol.ImageTileOptions tile = DASHBOARD_TILE;
        // Warm up the legacy container with a carrier-sized blank BMP. Real
        // 640x480 frames use mode 6 and are intentionally independent of this
        // geometry; a mismatched raw BMP would be rejected by the stock loader.
        byte[] bmp = BmpUtil.build4bppBmpFromPacked(
            new byte[((tile.width + 1) >> 1) * tile.height], tile.width, tile.height);
        int sessionId = nextMapSessionId();
        List<BleProtocol.ImageFragment> fragments = BleImageOptimizer.planImageFragments(bmp, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        for (BleProtocol.ImageFragment fragment : fragments) {
            OutboundMessage message = messageBuilder.imageWarmupFragment(tile, sessionId, fragment, bmp, connectionOptions.sendImagesToLeft);
            pendingMessages.addLast(message);
            message.onAck = () -> {
                // The first tile warmup primes the image path but does not reliably
                // guarantee that the tile is now visible on-screen, so it must not
                // update the displayed-tile cache used by image dedupe.
                warmedUp = true;
                // Warmup fragments are image messages on the wire, so they reset
                // the firmware's heartbeat timer just like real image updates.
                lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            };
            message.onTimeout = () -> {
                warmedUp = false;
                clearMessagesOfKindLocked("warmup");
                displayedFingerprint = "";
            };
        }
        logLine("queue blank warmup");
    }

    /**
     * Send the CFW mode-7 diagnostic-flag control op to the dashboard container:
     * [7][2] to show the on-glasses debug-flag overlay, [7][1] to hide it. Uses the
     * arbitrary-payload image path (no bmp/dedup/frame-timing interaction) and does
     * nothing on stock firmware (which ignores unknown image modes).
     */
    private void enqueueFirmwareDebugFlagsLocked() {
        boolean show = firmwareDebugFlagsEnabled;
        int sub = show ? 2 : 1;
        byte[] payload = new byte[] { (byte) 7, (byte) sub };
        OutboundMessage message = messageBuilder.imagePayload(
            DASHBOARD_TILE, nextMapSessionId(), payload,
            "fw-debug-flags " + (show ? "show" : "hide"),
            connectionOptions.sendImagesToLeft);
        pendingMessages.addLast(message);
        firmwareDebugFlagsLastSent = sub;
        logLine("queue firmware debug flags " + (show ? "show" : "hide"));
    }

    /** Send CFW image-handler mode 10: [10][1] start, [10][0] stop. */
    private void enqueueCompassControlLocked(boolean priority, boolean enable) {
        int sentState = enable ? 1 : 0;
        byte[] payload = new byte[] { (byte) 10, (byte) sentState };
        OutboundMessage message = messageBuilder.imagePayload(
            "compass-control",
            DASHBOARD_TILE,
            nextMapSessionId(),
            payload,
            "compass " + (enable ? "enable" : "disable"),
            connectionOptions.sendImagesToLeft);
        message.onTimeout = () -> {
            compassControlLastSent = -1;
            logLine("compass control ack timeout");
        };
        if (enable) {
            compassMaybeOn = true;
        } else {
            message.onAck = () -> compassMaybeOn = false;
        }
        if (priority) pendingMessages.addFirst(message);
        else pendingMessages.addLast(message);
        compassControlLastSent = sentState;
        logLine("queue " + message.label);
    }

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        byte[] packed;
        int width;
        int height;
        int paintMs;
        int frameId;
        synchronized (desiredTilesLock) {
            packed = desiredPacked;
            width = desiredWidth;
            height = desiredHeight;
            paintMs = desiredPaintMs;
            frameId = desiredFrameId;
            desiredFrameId = 0;
        }
        if (packed == null) {
            packed = new byte[0];
        }
        if (lastEnqueuedWidth == width && lastEnqueuedHeight == height
                && Arrays.equals(packed, lastEnqueuedPacked)) {
            lastEnqueuedFingerprint = fingerprint;
            finishFrame(frameId, "discarded: image content identical to displayed");
            return;
        }

        FrameTimings.getInstance().spanStart(frameId, "compress-and-plan");
        // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
        // (the base the firmware shadow will hold when this update is applied).
        // lastEnqueuedPacked is cleared whenever the image pipeline is cleared, so
        // a non-empty value means the display base is trusted.
        byte[] incrementalPayload = null;
        String incrementalLog = null;
        if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedPacked.length > 0
                && lastEnqueuedWidth == width && lastEnqueuedHeight == height) {
            int baseFid = nextImageFrameId;
            BleImageOptimizer.IncrementalPlan single =
                BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedPacked, packed, width, height, baseFid);
            if (single != null) {
                incrementalPayload = single.payload;
                // advance only when a delta is actually emitted, so consecutive
                // deltas carry consecutive ids (CFW skip/reorder detection)
                nextImageFrameId = nextImageFrameId >= 0xfffe ? 1 : nextImageFrameId + 1;
                incrementalLog = "incremental update bbox="
                    + ((single.payload[3] & 0xff) * 4) + "x" + ((single.payload[4] & 0xff) * 2)
                    + "+" + ((single.payload[1] & 0xff) * 4) + "+" + ((single.payload[2] & 0xff) * 2)
                    + " changed=" + single.changedBytes + "/" + single.boxBytes + "B"
                    + " clusters=" + single.clusterCount;

                // When the bounding box spans multiple clusters or is sizeable, try
                // splitting into tight rects (CFW mode-8). Only replace the single
                // box if the multi-rect message is actually smaller on the wire.
                if (connectionOptions.MULTI_RECT_FRAMES
                        && (single.clusterCount > 1 || single.payload.length > ConnectionOptions.MULTI_RECT_MIN_PAYLOAD)) {
                    BleImageOptimizer.MultiRectPlan multi = BleImageOptimizer.buildMultiRectImagePayload(
                        lastEnqueuedPacked, packed, width, height, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS);
                    if (multi != null && multi.payload.length < single.payload.length) {
                        incrementalPayload = multi.payload;
                        nextImageFrameId = multi.nextFid;   // rectCount fids consumed
                        incrementalLog = "multi-rect update n=" + multi.rectCount
                            + " covered=" + multi.coveredBytes + "B"
                            + " payload=" + multi.payload.length + "B (vs bbox " + single.payload.length + "B)";
                    }
                }
            }
        }
        BleImageOptimizer.TileImagePlan plan = incrementalPayload != null
            ? new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId(), incrementalPayload)
            : new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, packed, width, height, nextMapSessionId());
        plan.fragments = BleImageOptimizer.planImageFragments(plan.payload, ConnectionOptions.IMAGE_FRAGMENT_SIZE);
        FrameTimings.getInstance().spanEnd(frameId, "compress-and-plan");
        if (incrementalLog != null) {
            FrameTimings.getInstance().log(frameId, incrementalLog);
        }

        int updateId = nextImageUpdateId++;
        int messageCount = plan.fragments.size();
        imageUpdateStats.put(updateId, new BleImageOptimizer.ImageUpdateStats(paintMs, 1, frameId));
        for (int i = 0; i < plan.fragments.size(); i++) {
            BleProtocol.ImageFragment fragment = plan.fragments.get(i);
            enqueueImageFragmentLocked(plan, fragment, fingerprint, updateId, i + 1, messageCount, true);
        }
        // This frame is now the base for the next delta (it will be the firmware
        // shadow once applied), even though it hasn't been acked yet ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¾ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¾Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€šÃ‚Â¦ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬ÃƒÂ¢Ã¢â‚¬Å¾Ã‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã‚Â¦ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â that is what
        // lets the next frame pipeline behind it. plan.packed is the full frame;
        // frames are immutable by convention, so referencing it is safe.
        lastEnqueuedPacked = plan.packed;
        lastEnqueuedWidth = plan.width;
        lastEnqueuedHeight = plan.height;
        lastEnqueuedFingerprint = fingerprint;

        FrameTimings.getInstance().log(frameId, "queued image update#" + updateId
                + " messages=" + messageCount + " payload=" + plan.payload.length + "B");
        logLine("queue image update#" + updateId + " fingerprint=" + fingerprint
                + " messages=" + messageCount);
    }

    private void enqueueImageFragmentLocked(
        BleImageOptimizer.TileImagePlan plan,
        BleProtocol.ImageFragment fragment,
        String fingerprint,
        int updateId,
        int messageNumber,
        int messageCount,
        boolean requestAck
    ) {
        OutboundMessage message = messageBuilder.imageFragment(fragment, plan, requestAck, connectionOptions.sendImagesToLeft);
        message.setImageUpdatePosition(updateId, messageNumber, messageCount);
        message.onAck = () -> {
            imageRetryAfterMs = 0;
            // Firmware >= 2.2.4.34 resets its heartbeat timer when it receives
            // image messages (not just heartbeats), so an acked image fragment
            // satisfies the heartbeat deadline and heartbeats stop contending
            // with active rendering.
            lastHeartbeatAckedAtMs = SystemClock.elapsedRealtime();
            logImageUpdateAckLandmarkLocked(message);
            boolean imageStillInFlight = false;
            for (OutboundMessage inFlight : inFlightMessages) {
                if ("image".equals(inFlight.kind)) {
                    imageStillInFlight = true;
                    break;
                }
            }
            if (!imageStillInFlight) {
                boolean imageStillQueued = false;
                for (OutboundMessage queued : pendingMessages) {
                    if ("image".equals(queued.kind)) {
                        imageStillQueued = true;
                        break;
                    }
                }
                if (!imageStillQueued) {
                    displayedFingerprint = fingerprint;
                }
            }
        };
        message.onTimeout = () -> {
            discardImageUpdateStatsLocked(message.imageUpdateId, "image ack timeout (will retry)");
            clearMessagesOfKindLocked("image");
            displayedFingerprint = "";
            imageRetryAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.IMAGE_RETRY_DELAY_MS;
        };
        pendingMessages.addLast(message);
    }

    private OutboundMessage createAudioControlMessageLocked(boolean enable) {
        OutboundMessage message = messageBuilder.enableOrDisableMic(enable);
        message.onAck = () -> {
            lastAudioControlAckMagic = message.magic;
            audioCaptureActive = message.label != null && message.label.contains("enable");
            logLine(audioCaptureActive ? "G2 mic enabled" : "G2 mic disabled");
        };
        message.onTimeout = () -> {
            handleTransportFailure("audio control ack timeout");
        };
        return message;
    }

    private boolean shouldPollBatteryLocked(long now) {
        return !shutdownRequested
                && sessionReady
                && pendingMessages.isEmpty()
                && inFlightMessages.isEmpty()
                && now - lastConnectionOrInputAtMs >= ConnectionOptions.BATTERY_INPUT_QUIET_MS
                && (lastBatteryRefreshAtMs == 0 || now - lastBatteryRefreshAtMs >= ConnectionOptions.BATTERY_REFRESH_INTERVAL_MS);
    }

    private OutboundMessage createBatteryQueryMessageLocked() {
        OutboundMessage message = messageBuilder.batteryQuery();
        message.onAck = () -> {
            BleProtocol.BatterySnapshot snapshot = BleProtocol.parseSettingsBattery(message.ackPayload);
            if (snapshot != null) {
                headsetBattery = snapshot.battery;
                headsetCharging = snapshot.charging;
                emitBatteryState(headsetBattery, headsetCharging);
                if (snapshot.silentMode >= 0) {
                    // Backstop for the push in onNotification: the firmware is
                    // confirmed to push silent-mode-on, but the off transition is
                    // not, so re-read the authoritative value on every poll.
                    updateSilentModeLocked(snapshot.silentMode > 0);
                }
                updateChargingModeLocked(snapshot.charging > 0, snapshot.battery);
            }
            BleProtocol.FirmwareInfo firmwareInfo = BleProtocol.parseSettingsFirmwareInfo(message.ackPayload);
            if (firmwareInfo != null) {
                emitFirmwareInfo(firmwareInfo);
            }
        };
        message.onTimeout = () -> {
            logLine("Battery query timed out");
        };
        return message;
    }

    /**
     * Track silent mode, which the wearer toggles by long-pressing both
     * touchpads at once. While it is on the firmware refuses input events and
     * app launches and powers the display down, so the glasses look dead even
     * though the BLE session is healthy; the phone UI says so explicitly.
     */
    private void updateSilentModeLocked(boolean silent) {
        int next = silent ? 1 : 0;
        if (silentMode == next) {
            return;
        }
        silentMode = next;
        logLine(silent ? "glasses entered silent mode" : "glasses left silent mode");
        emitSilentMode(silent);
    }

    /**
     * Track whether the glasses are in the charging case. Charging means nobody
     * is wearing them: display communication pauses (no heartbeats, so the
     * firmware tears down its EvenHub context on its own) and only battery polls
     * continue. When charging stops, tear the transport down and let the normal
     * reconnect loop rebuild the session, layout, and first frame.
     */
    private void updateChargingModeLocked(boolean charging, int battery) {
        if (charging == chargingMode) {
            if (chargingMode) {
                setStateDisplay("charging", chargingStatusText(battery));
            }
            return;
        }
        if (charging) {
            chargingMode = true;
            clearAllMessagesLocked("glasses charging");
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            displayedFingerprint = "";
            finishDesiredFrameLocked("discarded: glasses charging");
            logLine("glasses are charging; pausing display communication");
            setStateDisplay("charging", chargingStatusText(battery));
        } else {
            chargingMode = false;
            logLine("glasses removed from charger; reconnecting");
            handleTransportFailure("charging ended");
        }
    }

    private static String chargingStatusText(int battery) {
        return battery >= 0
            ? "Glasses charging. Battery " + battery + "%."
            : "Glasses charging.";
    }

    private void finishDesiredFrameLocked(String outcome) {
        int frameIdToFinish;
        synchronized (desiredTilesLock) {
            frameIdToFinish = desiredFrameId;
            desiredFrameId = 0;
        }
        finishFrame(frameIdToFinish, outcome);
    }

    private boolean hasPendingOrInflightKindLocked(String kind) {
        for (OutboundMessage queued : pendingMessages) {
            if (kind.equals(queued.kind)) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (kind.equals(inFlight.kind)) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingOrInflightMagicLocked(int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.magic == magic) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (inFlight.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private boolean hasPendingMagicLocked(int sid, int magic) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.sid == sid && queued.magic == magic) {
                return true;
            }
        }
        return false;
    }

    private void handleAckTimeoutLocked(OutboundMessage message) {
        // Sequenced H.264 has its own bounded retry/replay state machine. Its
        // deliberate cancellation and recovery must not poison the generic
        // connection-wide timeout counter and force an otherwise healthy reconnect.
        if (!message.h264Payload) consecutiveAckTimeouts += 1;

        if (message.onTimeout != null) {
            message.onTimeout.run();
        }

        if (!message.h264Payload
                && consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
            handleTransportFailure("too many ack timeouts");
        }
    }

    /**
     * Replace any stale lease control with one right-arm and one left-arm
     * fire-and-forget write. With priority=true the right arm is sent first so
     * CLAIM reaches the lens that originated the deferred wake immediately.
     */
    private int enqueueFaceclawWakeControlLocked(int operation, int nonce, boolean priority) {
        clearMessagesOfKindLocked("wake-lease-control");
        final int generation = ++faceclawWakeControlGeneration;
        faceclawWakeControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_WAKE_OP_ACQUIRE) {
            lastFaceclawWakeLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawWakeControlGeneration == generation) {
                faceclawWakeControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawWakeControl(operation, nonce, false);
        OutboundMessage left = messageBuilder.faceclawWakeControl(operation, nonce, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawWakeControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawWakeControlGeneration == generation
                    && faceclawWakeControlSentCount < 2) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return faceclawWakeControlGeneration == generation
                && faceclawWakeControlSentCount >= 2;
        }
    }

    /**
     * Acquire/renew or release CFW's independent direct-framebuffer repaint
     * guard on both arms. It is separate from the optional idle-wake lease:
     * every Faceclaw display session needs this guard while its EvenHub layout
     * contains swipe-capturing stock widgets.
     */
    private int enqueueFaceclawFramebufferControlLocked(int operation, boolean priority) {
        clearMessagesOfKindLocked("framebuffer-lease-control");
        final int generation = ++faceclawFramebufferControlGeneration;
        faceclawFramebufferControlSentCount = 0;
        if (operation == BleProtocol.FACECLAW_FB_OP_ACQUIRE) {
            lastFaceclawFramebufferLeaseQueuedAtMs = SystemClock.elapsedRealtime();
        }
        Runnable onSent = () -> {
            if (faceclawFramebufferControlGeneration == generation) {
                faceclawFramebufferControlSentCount += 1;
            }
        };
        OutboundMessage right = messageBuilder.faceclawFramebufferControl(operation, false);
        OutboundMessage left = messageBuilder.faceclawFramebufferControl(operation, true);
        right.onSent = onSent;
        left.onSent = onSent;
        if (priority) {
            pendingMessages.addFirst(left);
            pendingMessages.addFirst(right);
        } else {
            pendingMessages.addLast(right);
            pendingMessages.addLast(left);
        }
        logLine("queue " + right.label + " + L");
        return generation;
    }

    private boolean waitForFaceclawFramebufferControlDelivery(int generation, long timeoutMs) {
        long deadline = SystemClock.elapsedRealtime() + Math.max(0, timeoutMs);
        synchronized (lock) {
            while (running
                    && sessionReady
                    && faceclawFramebufferControlGeneration == generation
                    && faceclawFramebufferControlSentCount < 2) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    break;
                }
                try {
                    lock.wait(Math.min(remaining, 100));
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return faceclawFramebufferControlGeneration == generation
                && faceclawFramebufferControlSentCount >= 2;
        }
    }

    private boolean releaseFaceclawFramebufferLease() {
        int generation;
        synchronized (lock) {
            if (!running || !sessionReady) {
                return true;
            }
            generation = enqueueFaceclawFramebufferControlLocked(
                BleProtocol.FACECLAW_FB_OP_RELEASE,
                true
            );
        }
        interruptibleSleep.interrupt();
        return waitForFaceclawFramebufferControlDelivery(
            generation,
            FACECLAW_WAKE_CONTROL_WAIT_MS
        );
    }

    private void clearMessagesOfKindLocked(String kind) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if (kind.equals(message.kind)) {
                pendingIterator.remove();
                discardPrewriteIfMatchesLocked(message);
                if ("image".equals(kind)) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared (" + kind + ")");
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared pending " + kind);
            }
        }
        Iterator<OutboundMessage> inFlightIterator = inFlightMessages.iterator();
        while (inFlightIterator.hasNext()) {
            OutboundMessage message = inFlightIterator.next();
            if (kind.equals(message.kind)) {
                inFlightIterator.remove();
                if ("image".equals(kind)) {
                    discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared (" + kind + ")");
                }
                magicPool.release(message.sid, message.magic, message.label, "cleared inflight " + kind);
            }
        }
        if ("image".equals(kind)) {
            // The image pipeline was flushed (e.g. ack timeout -> keyframe resync):
            // drop the pipelined delta base so the next image is a full keyframe.
            lastEnqueuedPacked = new byte[0];
            lastEnqueuedFingerprint = "";
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
        // The image pipeline is gone: drop the pipelined delta base so the next
        // image is a full keyframe rather than a delta onto a stale base.
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
    }

    /**
     * A custom wake queues CLAIM before NativeScript asks for a resume. Keep
     * that private control while flushing stale EvenHub traffic around the
     * direct prelude write.
     */
    private void clearAllMessagesPreservingWakeLeaseLocked(String reason) {
        Iterator<OutboundMessage> pendingIterator = pendingMessages.iterator();
        while (pendingIterator.hasNext()) {
            OutboundMessage message = pendingIterator.next();
            if ("wake-lease-control".equals(message.kind)) {
                continue;
            }
            pendingIterator.remove();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(
                message.imageUpdateId,
                "pending messages cleared: " + reason
            );
            magicPool.release(
                message.sid,
                message.magic,
                message.label,
                "cleared pending: " + reason
            );
        }
        clearInFlightMessagesLocked(reason);
        lastEnqueuedPacked = new byte[0];
        lastEnqueuedFingerprint = "";
    }

    /** Any image update whose fragments are still queued (not yet sent). */
    private boolean hasPendingImageLocked() {
        for (OutboundMessage message : pendingMessages) {
            if ("image".equals(message.kind)) {
                return true;
            }
        }
        return false;
    }

    private void clearPendingMessagesLocked(String reason) {
        while (!pendingMessages.isEmpty()) {
            var message = pendingMessages.removeFirst();
            discardPrewriteIfMatchesLocked(message);
            discardImageUpdateStatsLocked(message.imageUpdateId, "pending messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared pending: " + reason);
        }
    }

    private void clearInFlightMessagesLocked(String reason) {
        while (!inFlightMessages.isEmpty()) {
            var message = inFlightMessages.removeFirst();
            discardImageUpdateStatsLocked(message.imageUpdateId, "inflight messages cleared: " + reason);
            magicPool.release(message.sid, message.magic, message.label, "cleared inflight: " + reason);
        }
    }

    private void discardPrewriteIfMatchesLocked(OutboundMessage message) {
        if (message != null && message == prewrittenMessage) {
            prewrittenMessage = null;
            prewrittenFrames = Collections.emptyList();
        }
    }

    private void recordUnexpectedAckLocked(int sid, int magic) {
        if (magic < BleMagicPool.MIN_MAGIC || magic > BleMagicPool.MAX_MAGIC) {
            return;
        }
        BleMagicPool.ReleaseRecord previous = magicPool.getReleaseRecord(sid, magic);
        if (previous == null) {
            String pendingNote = hasPendingMagicLocked(sid, magic) ? " while that magic is only pending locally" : "";
            logLine("unexpected ACK sid=" + sid + " magic=" + magic + pendingNote
                    + "; possible Even app BLE contention");
            return;
        }
        if ("timeout".equals(previous.reason)) {
            logLine("late ACK after timeout sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; ACK timeout may be too short");
            return;
        }
        if ("ack".equals(previous.reason)) {
            logLine("duplicate ACK for already-acked message sid=" + sid + " magic=" + magic
                    + " label=" + previous.label
                    + "; possible Even app BLE contention");
            return;
        }
        logLine("late ACK for released message sid=" + sid + " magic=" + magic
                + " label=" + previous.label
                + " release=" + previous.reason);
    }

    private void handleTransportFailure(String reason) {
        Log.e(TAG, "Transport failure: "+reason);
        synchronized (lock) {
            maybeEmitEvenAppConflictLocked(reason);
            sessionReady = false;
            fixedLayoutCreated = false;
            warmedUp = false;
            startupProbePending = false;
            shutdownRequested = false;
            chargingMode = false;
            imageRetryAfterMs = 0;
            displayedFingerprint = "";
            faceclawWakePendingNonce = -1;
            lastFaceclawWakeLeaseQueuedAtMs = 0;
            faceclawWakeControlSentCount = 0;
            clearAllMessagesLocked("transport failure: " + reason);
            reconnectAfterMs = SystemClock.elapsedRealtime() + ConnectionOptions.RECONNECT_DELAY_MS;
            bleManager.disconnect(rightAddress);
            bleManager.disconnect(leftAddress);
        }
        if (!userDisconnectRequested) {
            setStateDisplay("retrying", reason == null || reason.isEmpty() ? "Reconnecting..." : "Reconnecting after " + reason);
        }
        interruptibleSleep.interrupt();
    }

    private void resetSessionStateLocked() {
        sessionReady = false;
        shutdownRequested = false;
        fixedLayoutCreated = false;
        warmedUp = false;
        chargingMode = false;
        rightConnected = false;
        leftConnected = false;
        ringConnected = false;
        ringNotificationsReady = false;
        reconnectAfterMs = 0;
        ringReconnectAfterMs = 0;
        lastAckAtMs = 0;
        lastIncomingAtMs = 0;
        lastHeartbeatSentAtMs = 0;
        lastSessionReadyAtMs = 0;
        consecutiveAckTimeouts = 0;
        lastAudioControlAckMagic = 0;
        audioCaptureActive = false;
        audioPacketListener = null;
        compassControlLastSent = -1;
        // A dead transport orphans any glasses-side compass state; the fresh
        // session re-asserts the desired state after warmup (lastSent = -1).
        compassMaybeOn = false;
        faceclawWakePendingNonce = -1;
        lastFaceclawWakeLeaseQueuedAtMs = 0;
        faceclawWakeControlSentCount = 0;
        wearState = -1;
        displayedFingerprint = "";
        // Deliberately not clearing silentMode: it is a property of the glasses,
        // not of our session, and silent mode blocks app launches, so it can be
        // the very cause of the session teardown that got us here.
    }

    private void emitRingEvent(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode, int frameId) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            FrameTimings.getInstance().finishFrame(frameId, "discarded: no listener attached");
            return;
        }
        final String containerNameSnapshot = containerName == null ? "" : containerName;
        mainHandler.post(() -> {
            FrameTimings.getInstance().log(frameId, "dispatching input event on main thread");
            try {
                current.onRingEvent(kind, containerNameSnapshot, eventType, eventSource, systemExitReasonCode, frameId);
            } catch (Throwable t) {
                Log.w(TAG, "listener onRingEvent failed", t);
                FrameTimings.getInstance().finishFrame(frameId, "discarded: listener onRingEvent failed");
            }
        });
    }

    /** Finish a frame owned by the communicator and tell the TS side, which may be awaiting it. */
    private void finishFrame(int frameId, String outcome) {
        if (frameId <= 0) {
            return;
        }
        FrameTimings.getInstance().finishFrame(frameId, outcome);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameFinished(frameId, outcome);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameFinished failed", t);
            }
        });
    }

    private void emitImuData(double x, double y, double z, int eventSource) {
        if (imuListeners.isEmpty()) {
            return;
        }
        mainHandler.post(() -> {
            for (FaceclawImuListener imuListener : imuListeners) {
                try {
                    imuListener.onImuData(x, y, z, eventSource);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onImuData failed", t);
                }
            }
        });
    }

    private void emitCompassEvent(int command, int headingDegrees) {
        if (compassListeners.isEmpty()) {
            return;
        }
        mainHandler.post(() -> {
            for (FaceclawCompassListener compassListener : compassListeners) {
                try {
                    compassListener.onCompassEvent(command, headingDegrees);
                } catch (Throwable t) {
                    Log.w(TAG, "listener onCompassEvent failed", t);
                }
            }
        });
    }

    private void emitSilentMode(boolean silent) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onSilentMode(silent);
            } catch (Throwable t) {
                Log.w(TAG, "listener onSilentMode failed", t);
            }
        });
    }

    private void emitWearState(boolean wearing) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onWearState(wearing);
            } catch (Throwable t) {
                Log.w(TAG, "listener onWearState failed", t);
            }
        });
    }

    private void emitPhoneLockStateIfChanged(boolean force) {
        final boolean locked;
        synchronized (lock) {
            long now = SystemClock.elapsedRealtime();
            if (!force && now - lastPhoneLockCheckAtMs < 1_000) return;
            lastPhoneLockCheckAtMs = now;
            locked = keyguardManager != null && keyguardManager.isDeviceLocked();
            int value = locked ? 1 : 0;
            if (!force && value == phoneLockState) return;
            phoneLockState = value;
        }
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) return;
        mainHandler.post(() -> {
            try {
                current.onPhoneLockState(locked);
            } catch (Throwable t) {
                Log.w(TAG, "listener onPhoneLockState failed", t);
            }
        });
    }

    private void emitBatteryState(int headsetBattery, int headsetCharging) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onBatteryState(headsetBattery, headsetCharging);
            } catch (Throwable t) {
                Log.w(TAG, "listener onBatteryState failed", t);
            }
        });
    }

    private void emitFirmwareInfo(BleProtocol.FirmwareInfo info) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFirmwareInfo(info.leftVersion, info.rightVersion, info.capabilities);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFirmwareInfo failed", t);
            }
        });
    }

    private void emitFrameMetrics(int paintMs, int transmitMs, int tileCount) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onFrameMetrics(paintMs, transmitMs, tileCount);
            } catch (Throwable t) {
                Log.w(TAG, "listener onFrameMetrics failed", t);
            }
        });
    }

    private void maybeEmitEvenAppConflictLocked(String reason) {
        if (!"write failed".equals(reason)) {
            return;
        }
        long now = SystemClock.elapsedRealtime();
        if (lastSessionReadyAtMs <= 0 || now - lastSessionReadyAtMs > ConnectionOptions.EVEN_APP_WRITE_FAILURE_WINDOW_MS) {
            return;
        }
        if (lastEvenAppConflictAtMs > 0 && now - lastEvenAppConflictAtMs < 60_000) {
            return;
        }
        if (!FaceclawEvenAppDetector.isEvenNotificationActive(appContext)) {
            return;
        }
        lastEvenAppConflictAtMs = now;
        emitEvenAppConflict("The Even Realities app still appears to be running. It can hold the glasses BLE link and cause Faceclaw write failures. Open its app settings and force stop it, then reconnect Faceclaw.");
    }

    private void emitEvenAppConflict(String message) {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String messageSnapshot = message == null ? "" : message;
        mainHandler.post(() -> {
            try {
                current.onEvenAppConflict(messageSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onEvenAppConflict failed", t);
            }
        });
    }

    private void setStateDisplay(String nextPhase, String nextStatus) {
        synchronized (lock) {
            phase = nextPhase;
            status = nextStatus;
        }
        emitState();
    }

    private void emitState() {
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        final String phaseSnapshot;
        final String statusSnapshot;
        synchronized (lock) {
            phaseSnapshot = phase;
            statusSnapshot = status;
        }
        mainHandler.post(() -> {
            try {
                current.onStateChange(phaseSnapshot, statusSnapshot);
            } catch (Throwable t) {
                Log.w(TAG, "listener onStateChange failed", t);
            }
        });
    }

    private void updateG2ScreenWakeLock(boolean screenOn) {
        if (screenOn) {
            if (g2ScreenWakeLock == null) {
                g2ScreenWakeLock = powerManager.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, G2_SCREEN_WAKE_LOCK_TAG);
                g2ScreenWakeLock.setReferenceCounted(false);
            }
            if (!g2ScreenWakeLock.isHeld()) {
                g2ScreenWakeLock.acquire();
                logLine("G2 screen wake lock acquired");
            }
            return;
        }
        releaseG2ScreenWakeLock();
    }

    private void releaseG2ScreenWakeLock() {
        if (g2ScreenWakeLock != null && g2ScreenWakeLock.isHeld()) {
            g2ScreenWakeLock.release();
            logLine("G2 screen wake lock released");
        }
    }

    private void logLine(String line) {
        Log.i(TAG, line);
        final FaceclawBleCommunicatorListener current = listener;
        if (current == null) {
            return;
        }
        mainHandler.post(() -> {
            try {
                current.onLog(line);
            } catch (Throwable t) {
                Log.w(TAG, "listener onLog failed", t);
            }
        });
    }

    private static String timestamp(long elapsedMs) {
        long wallMs = System.currentTimeMillis();
        return String.format(Locale.US, "%tF %tT.%tL elapsed=%dms", wallMs, wallMs, wallMs, elapsedMs);
    }

    private int nextMapSessionId() {
        int id = nextMapSessionId;
        int increment = connectionOptions.skipSessionIds ? 2 : 1;
        nextMapSessionId = (nextMapSessionId + increment) & 0xff;
        return id;
    }

    private static String requireAddress(String name, String address) {
        if (address == null || address.trim().isEmpty()) {
            throw new IllegalArgumentException(name + " is required");
        }
        return address.trim();
    }

    private boolean hasRingAddress() {
        return ringAddress != null && !ringAddress.trim().isEmpty();
    }

    private boolean isConfiguredRingAddress(String address) {
        return hasRingAddress() && address != null && address.equalsIgnoreCase(ringAddress);
    }

    private boolean isDirectRingNotification(String address, String characteristicUuid) {
        if (!isConfiguredRingAddress(address) || characteristicUuid == null) {
            return false;
        }
        return BleProtocol.R1_PHONE_NOTIFY_CHAR_UUID.equals(characteristicUuid)
            || BleProtocol.R1_NOTIFY_CHAR_UUID.equals(characteristicUuid);
    }

    private static String hex(byte[] data) {
        if (data == null || data.length == 0) {
            return "";
        }
        char[] out = new char[data.length * 2];
        char[] digits = "0123456789abcdef".toCharArray();
        for (int i = 0; i < data.length; i++) {
            int value = data[i] & 0xff;
            out[i * 2] = digits[value >>> 4];
            out[i * 2 + 1] = digits[value & 0x0f];
        }
        return new String(out);
    }

    private static String safeMessage(Throwable t) {
        if (t == null) {
            return "unknown";
        }
        StringWriter writer = new StringWriter();
        t.printStackTrace(new PrintWriter(writer));
        String trace = writer.toString();
        if (!trace.trim().isEmpty()) {
            return trace;
        }
        String message = t.getMessage();
        return message == null || message.trim().isEmpty() ? String.valueOf(t) : message;
    }

    private String getDesiredFingerprint() {
        synchronized (desiredTilesLock) {
            return desiredFingerprint;
        }
    }
}
