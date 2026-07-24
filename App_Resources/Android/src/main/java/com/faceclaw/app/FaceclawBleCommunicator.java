package com.faceclaw.app;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCharacteristic;
import android.content.Context;
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

    // A single full-screen image container. Earlier firmware capped image tiles at
    // 288x144, which forced a 2x2 tile layout; the custom firmware lifts that limit,
    // so the dashboard is now one 576x288 container.
    private static final BleProtocol.ImageTileOptions DASHBOARD_TILE =
        new BleProtocol.ImageTileOptions("img00", 10, 0, 0, 576, 288);

    private static final String G2_SCREEN_WAKE_LOCK_TAG = "Faceclaw:G2Screen";
    private static final long FACECLAW_WAKE_LEASE_RENEW_MS = 45_000;
    private static final long FACECLAW_WAKE_CONTROL_WAIT_MS = 1_500;

    private final Context appContext;
    private final PowerManager powerManager;
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
    private boolean startupProbePending;
    // Desired ownership of CFW's fail-open idle-wake lease. This survives a
    // transport reconnect; the lease itself is volatile firmware state and is
    // re-acquired once both arms are ready.
    private boolean faceclawWakeLeaseEnabled;
    private long lastFaceclawWakeLeaseQueuedAtMs;
    private int faceclawWakeControlGeneration;
    private int faceclawWakeControlSentCount;
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
    private boolean audioCaptureActive;
    private boolean firmwareInfoQueried;
    // Glasses are in the charging case: nobody is wearing them, so display
    // communication pauses and only battery polls flow (see driveSession).
    private boolean chargingMode;
    private volatile FaceclawAudioPacketListener audioPacketListener;
    private PowerManager.WakeLock g2ScreenWakeLock;

    private String displayedFingerprint = "";
    private byte[] displayedBmp = new byte[0];
    // The frame the firmware shadow will hold once the current image pipeline
    // drains: the most recently ENQUEUED image, which is the correct base for the
    // next delta when frames are pipelined (displayedBmp only reflects the last
    // ACKED frame and lags behind). Set at enqueue; cleared whenever the image
    // pipeline is cleared (clearAllMessagesLocked / clearMessagesOfKindLocked
    // "image"), so it is only ever read while it holds a valid current-session base.
    private byte[] lastEnqueuedImageBmp = new byte[0];
    private String lastEnqueuedFingerprint = "";
    private final Map<Integer, BleImageOptimizer.ImageUpdateStats> imageUpdateStats = new HashMap<>();

    private final Object desiredTilesLock = new Object();
    private String desiredFingerprint = "";
    private byte[] desiredBmp = new byte[0];
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
        this.bleManager = new FaceclawBleManager(appContext);
        this.bleManager.setListener(this);
        this.rightAddress = requireAddress("rightAddress", rightAddress);
        this.leftAddress = requireAddress("leftAddress", leftAddress);
        this.ringAddress = ringAddress == null ? "" : ringAddress.trim();
    }


    public void setListener(FaceclawBleCommunicatorListener listener) {
        this.listener = listener;
        emitState();
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
     * the fail-open firmware policy is installed before suspending EvenHub.
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

    /** Save the current composite as a raw 4bpp screenshot; returns the path or "". */
    public String saveRawCompositeScreenshot() throws java.io.IOException {
        SurfaceCompositor.Composite composite = compositor.previewComposite();
        if (composite == null) {
            return "";
        }
        return ScreenshotUtil.saveRawScreenshot(
                appContext, java.nio.ByteBuffer.wrap(composite.gray), composite.width, composite.height);
    }

    /**
     * Show or hide a compositor surface, immediately submitting the resulting
     * frame. Recompositing here (rather than waiting for the next surface
     * update) is what makes a just-foregrounded window's retained frame
     * actually appear — otherwise a static window (e.g. the terminal hub) whose
     * frame landed while briefly hidden would stay blank until its next repaint.
     */
    public void setSurfaceVisible(String id, boolean visible) {
        compositor.setSurfaceVisible(id, visible);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] bmp = BmpUtil.build4bppBmp(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, bmp, 0, 0);
    }

    /**
     * Blank (screen off) or unblank the composited output, immediately
     * submitting the resulting frame. Retained surface state is untouched, so
     * unblanking restores the previous screen content without repaints.
     */
    public void setScreenBlanked(boolean blanked) {
        compositor.setBlanked(blanked);
        SurfaceCompositor.Composite composite = compositor.composite();
        byte[] bmp = BmpUtil.build4bppBmp(composite.gray, composite.width, composite.height);
        storeDesiredComposite(composite, bmp, 0, 0);
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
        // Convert the composited 8bpp buffer into the BMP wire format here so
        // that all framing concerns live on the Java side.
        FrameTimings.getInstance().spanStart(frameId, "bmp-convert");
        byte[] bmp = BmpUtil.build4bppBmp(composite.gray, composite.width, composite.height);
        FrameTimings.getInstance().spanEnd(frameId, "bmp-convert");
        storeDesiredComposite(composite, bmp, paintMs, frameId);
    }

    /** Store a composite as the desired frame unless a newer one won the race. */
    private void storeDesiredComposite(SurfaceCompositor.Composite composite, byte[] bmp, int paintMs, int frameId) {
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
                desiredBmp = bmp;
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
     * desiredBmp.
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
            displayedBmp = new byte[0];
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
                displayedBmp = new byte[0];
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
        Log.d(TAG, "onNotification: address=" + address + " characteristicUuid=" + characteristicUuid + " data.length=" + data.length);
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        G2Event event = null;
        synchronized (lock) {
            lastIncomingAtMs = SystemClock.elapsedRealtime();
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
                    && frame.ok
                    && frame.msgSeq >= 0
                    && frame.flag != BleProtocol.FLAG_NOTIFY
                    && frame.flag != BleProtocol.FLAG_NOTIFY_ALT) {
                lastAckAtMs = lastIncomingAtMs;
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
                            displayedBmp = new byte[0];
                            clearAllMessagesLocked("firmware exit event");
                        }
                    }
                }
            }
        }
        interruptibleSleep.interrupt();
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
                displayedBmp = new byte[0];
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
                displayedBmp = new byte[0];
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
                    if (connectionOptions.WINDOW_SIZE <= 1
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

                    if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && (firmwareDebugFlagsEnabled ? 2 : 1) != firmwareDebugFlagsLastSent
                            && pendingMessages.isEmpty() && inFlightMessages.isEmpty()) {
                        Log.i(TAG, "enqueueing firmware debug flags " + (firmwareDebugFlagsEnabled ? "show" : "hide"));
                        enqueueFirmwareDebugFlagsLocked();
                    }

                    // Up to WINDOW_SIZE messages may be in flight at once (full
                    // pipelining); a slot frees when an ack arrives.
                    boolean windowHasRoom = inFlightMessages.size() < Math.max(1, connectionOptions.WINDOW_SIZE);
                    // A frame ready to send right now: don't inject a fresh
                    // heartbeat in front of it (the image's own ack resets the
                    // firmware heartbeat timer, so the heartbeat is redundant).
                    boolean imageWaiting = !shutdownRequested && fixedLayoutCreated && warmedUp
                            && !hasPendingOrInflightKindLocked("heartbeat")
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint);
                    if (messageToPrewrite == null && handleHeartbeat(imageWaiting)) {
                        return ConnectionOptions.IDLE_SLEEP_MS;
                    }

                    if (messageToPrewrite == null && sessionReady && windowHasRoom && !pendingMessages.isEmpty()) {
                        messageToWrite = pendingMessages.removeFirst();
                        Log.i(TAG, "sending pending message: " + messageToWrite.label);
                    } else if (messageToPrewrite == null && !shutdownRequested && fixedLayoutCreated && warmedUp
                            && windowHasRoom && !hasPendingImageLocked()
                            && now >= imageRetryAfterMs
                            && !getDesiredFingerprint().equals(lastEnqueuedFingerprint)) {
                        // Enqueue the next frame's delta against lastEnqueuedImageBmp
                        // (what the shadow will be), so it can pipeline behind an
                        // image still awaiting its ack.
                        Log.i(TAG, "Enqueued image update");
                        enqueueDesiredImageLocked();
                        return 0;
                    } else if (messageToPrewrite == null && shouldPollBatteryLocked(now)) {
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
        if (message.magic != 0) {
            synchronized (lock) {
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
        boolean result = bleManager.writeFrames(
            writeAddress,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS
        );

        synchronized (lock) {
            long sentAtMs = SystemClock.elapsedRealtime();
            message.sentAtMs = sentAtMs;
            message.ackDeadlineAtMs = sentAtMs + message.ackTimeoutMs;
            logImageUpdateSendLandmarkLocked(message);
            if (result && message.onSent != null) {
                message.onSent.run();
                lock.notifyAll();
            }
        }

        return result;
    }

    private boolean prewriteMessage(OutboundMessage message) {
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
            displayedBmp = new byte[0];
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
            displayedBmp = new byte[0];
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
        byte[] bmp;
        synchronized (desiredTilesLock) {
            bmp = desiredBmp;
        }
        if (bmp == null || bmp.length == 0) {
            bmp = new byte[] {0};
        }
        bmp = BmpUtil.buildBlankWarmupBmp(bmp);
        BleProtocol.ImageTileOptions tile = DASHBOARD_TILE;
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
                displayedBmp = new byte[0];
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

    private void enqueueDesiredImageLocked() {
        String fingerprint = getDesiredFingerprint();
        byte[] bmp;
        int paintMs;
        int frameId;
        synchronized (desiredTilesLock) {
            bmp = desiredBmp;
            paintMs = desiredPaintMs;
            frameId = desiredFrameId;
            desiredFrameId = 0;
        }
        if (bmp == null) {
            bmp = new byte[0];
        }
        if (Arrays.equals(bmp, lastEnqueuedImageBmp)) {
            lastEnqueuedFingerprint = fingerprint;
            finishFrame(frameId, "discarded: image content identical to displayed");
            return;
        }

        FrameTimings.getInstance().spanStart(frameId, "compress-and-plan");
        // Incremental (mode 3 bounding box) update against the last ENQUEUED frame
        // (the base the firmware shadow will hold when this update is applied).
        // lastEnqueuedImageBmp is cleared whenever the image pipeline is cleared, so
        // a non-empty value means the display base is trusted.
        byte[] incrementalPayload = null;
        String incrementalLog = null;
        if (connectionOptions.INCREMENTAL_FRAMES && lastEnqueuedImageBmp.length > 0) {
            int baseFid = nextImageFrameId;
            BleImageOptimizer.IncrementalPlan single =
                BleImageOptimizer.buildIncrementalImagePayload(lastEnqueuedImageBmp, bmp, baseFid);
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
                        lastEnqueuedImageBmp, bmp, baseFid, ConnectionOptions.MULTI_RECT_MAX_RECTS);
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
            ? new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, bmp, nextMapSessionId(), incrementalPayload)
            : new BleImageOptimizer.TileImagePlan(0, DASHBOARD_TILE, bmp, nextMapSessionId());
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
        // shadow once applied), even though it hasn't been acked yet — that is what
        // lets the next frame pipeline behind it. plan.bmp is the full frame.
        lastEnqueuedImageBmp = BmpUtil.copyTileBmp(plan.bmp);
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
            if (message.tileIndex >= 0 && !hasPendingOrInflightTileLocked(message.tileIndex)) {
                displayedBmp = BmpUtil.copyTileBmp(plan.bmp);
            }
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
            displayedBmp = new byte[0];
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
            displayedBmp = new byte[0];
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
        consecutiveAckTimeouts += 1;

        if (message.onTimeout != null) {
            message.onTimeout.run();
        }

        if (consecutiveAckTimeouts > ConnectionOptions.MAX_CONSECUTIVE_ACK_TIMEOUTS) {
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
            lastEnqueuedImageBmp = new byte[0];
            lastEnqueuedFingerprint = "";
        }
    }

    private void clearAllMessagesLocked(String reason) {
        clearPendingMessagesLocked(reason);
        clearInFlightMessagesLocked(reason);
        // The image pipeline is gone: drop the pipelined delta base so the next
        // image is a full keyframe rather than a delta onto a stale base.
        lastEnqueuedImageBmp = new byte[0];
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
        lastEnqueuedImageBmp = new byte[0];
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
            displayedBmp = new byte[0];
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
        faceclawWakePendingNonce = -1;
        lastFaceclawWakeLeaseQueuedAtMs = 0;
        faceclawWakeControlSentCount = 0;
        displayedFingerprint = "";
        displayedBmp = new byte[0];
        // Deliberately not clearing silentMode: it is a property of the glasses,
        // not of our session, and silent mode blocks app launches, so it can be
        // the very cause of the session teardown that got us here.
    }

    private boolean hasPendingOrInflightTileLocked(int tileIndex) {
        for (OutboundMessage queued : pendingMessages) {
            if (queued.tileIndex == tileIndex && ("image".equals(queued.kind) || "warmup".equals(queued.kind))) {
                return true;
            }
        }
        for (OutboundMessage inFlight : inFlightMessages) {
            if (inFlight.tileIndex == tileIndex && ("image".equals(inFlight.kind) || "warmup".equals(inFlight.kind))) {
                return true;
            }
        }
        return false;
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
