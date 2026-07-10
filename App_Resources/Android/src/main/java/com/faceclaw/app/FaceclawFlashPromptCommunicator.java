package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

/**
 * A minimal, stock-firmware-compatible BLE communicator used only to show the
 * pre-flash confirmation prompt on the glasses and read back the user's Yes/No
 * choice. It is deliberately separate from FaceclawBleCommunicator: the main
 * app assumes the custom firmware (image containers, compositor, etc.), whereas
 * this must work on unmodified glasses, so it speaks only the stock subset —
 * session prelude, a text container, a list container, and heartbeats. No
 * images.
 *
 * It reuses the low-level GATT wrapper (FaceclawBleManager) and the framing /
 * protobuf helpers (BleProtocol), but owns its own GATT connection and runs its
 * whole lifecycle on a single worker thread. It expects the main app to be
 * disconnected while it runs (onboarding, before flashing).
 */
public class FaceclawFlashPromptCommunicator implements FaceclawBleListener {
    private static final String TAG = "FaceclawFlashPrompt";

    private static final String TEXT_NAME = "flashwarn";
    private static final String LIST_NAME = "flashmenu";
    private static final int TEXT_CONTAINER_ID = 1;
    private static final int LIST_CONTAINER_ID = 2;
    // Index 0 = decline, index 1 = approve. Kept short for the ~50-col grid.
    private static final String[] ITEMS = new String[] {"No, cancel", "Yes, flash"};

    private static final int HEARTBEAT_INTERVAL_MS = 4_000;
    private static final int SELECTION_TIMEOUT_MS = 120_000;
    private static final int CREATE_ACK_TIMEOUT_MS = 3_000;

    private final Context context;
    private final String rightAddress;
    private final String leftAddress;
    private final String warningText;
    private final FaceclawBleManager bleManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private final ConcurrentHashMap<String, CountDownLatch> pendingAcks = new ConcurrentHashMap<>();
    private final CountDownLatch selectionLatch = new CountDownLatch(1);

    private volatile FaceclawFlashPromptListener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;
    private volatile boolean finished = false;
    private volatile boolean rightConnected = false;
    private volatile boolean leftConnected = false;
    private volatile boolean rightLost = false;
    private volatile Boolean approved = null;
    private volatile ScheduledExecutorService heartbeatExecutor;

    private int nextMagic = 100;
    private int nextSeq = 0x40;

    public FaceclawFlashPromptCommunicator(Context context, String rightAddress, String leftAddress, String warningText) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.leftAddress = leftAddress == null ? "" : leftAddress;
        this.warningText = warningText == null ? "" : warningText;
        this.bleManager = new FaceclawBleManager(this.context);
        this.bleManager.setListener(this);
    }

    public void setListener(FaceclawFlashPromptListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (worker != null) {
                return;
            }
            worker = new Thread(this::run, "faceclaw-flash-prompt");
            worker.start();
        }
    }

    /** Abort the prompt (e.g. the user backed out on the phone). */
    public void cancel() {
        cancelled = true;
        selectionLatch.countDown();
        Thread w = worker;
        if (w != null) {
            w.interrupt();
        }
    }

    public void close() {
        cancel();
        stopHeartbeat();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
    }

    private void run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitState("error", "No right-arm address configured.");
                return;
            }

            emitState("connecting", "");
            connectArm(rightAddress, "right");
            rightConnected = true;

            boolean haveLeft = !leftAddress.trim().isEmpty() && !leftAddress.equalsIgnoreCase(rightAddress);
            if (haveLeft) {
                try {
                    connectArm(leftAddress, "left");
                    leftConnected = true;
                } catch (Exception e) {
                    emitLog("left arm connect failed (continuing on right only): " + e.getMessage());
                }
            }
            if (cancelled) {
                teardown();
                return;
            }

            emitState("connected", "");
            bringUpArm(rightAddress);
            if (leftConnected) {
                try {
                    bringUpArm(leftAddress);
                } catch (Exception e) {
                    emitLog("left arm prompt failed (continuing on right only): " + e.getMessage());
                    leftConnected = false;
                }
            }

            startHeartbeat();
            emitState("prompting", "");

            boolean signalled = selectionLatch.await(SELECTION_TIMEOUT_MS, TimeUnit.MILLISECONDS);
            stopHeartbeat();

            if (cancelled) {
                emitState("cancelled", "");
                teardown();
                return;
            }
            if (approved != null) {
                boolean result = Boolean.TRUE.equals(approved);
                try {
                    sendShutdownBoth();
                } catch (Exception ignored) {
                }
                emitResult(result);
                emitState("result", result ? "approved" : "declined");
                teardown();
                return;
            }
            if (rightLost) {
                emitState("disconnected", "Lost connection to the glasses.");
            } else {
                emitState("timeout", "No response from the glasses.");
            }
            teardown();
        } catch (Exception e) {
            stopHeartbeat();
            if (!cancelled) {
                String message = e.getMessage() == null ? e.toString() : e.getMessage();
                emitState("error", message);
            }
            teardown();
        }
    }

    private void connectArm(String address, String labelForLog) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed: " + address);
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("discoverServices failed: " + address);
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("enableNotifications failed: " + address);
        }
        emitLog("connected " + labelForLog + " arm");
    }

    private void bringUpArm(String address) throws InterruptedException {
        // 1. Mandatory session prelude on sid=0x01 (app-launch).
        if (!writeAndAwaitAck(
                address,
                BleProtocol.PRELUDE_ACK_SID,
                BleProtocol.FLAG_REQUEST,
                BleProtocol.PRELUDE_ACK_MAGIC,
                BleProtocol.PRELUDE_F5872_PAYLOAD,
                ConnectionOptions.PRELUDE_TIMEOUT_MS)) {
            throw new IllegalStateException("session prelude not acked: " + address);
        }
        // 2. Create the prompt page (warning text + No/Yes list) on sid=0xe0 Cmd=0.
        int magic = allocMagic();
        byte[] page = BleProtocol.buildCreatePromptPage(
            magic, TEXT_NAME, TEXT_CONTAINER_ID, warningText, LIST_NAME, LIST_CONTAINER_ID, ITEMS);
        if (!writeAndAwaitAck(address, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, magic, page, CREATE_ACK_TIMEOUT_MS)) {
            throw new IllegalStateException("prompt page not acked: " + address);
        }
        emitLog("prompt page shown on " + address);
    }

    private boolean writeAndAwaitAck(String address, int sid, int flag, int magic, byte[] payload, int timeoutMs)
            throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        String key = ackKey(sid, magic);
        pendingAcks.put(key, latch);
        try {
            if (!writeFrame(address, sid, flag, payload)) {
                return false;
            }
            return latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        } finally {
            pendingAcks.remove(key, latch);
        }
    }

    private boolean writeFrame(String address, int sid, int flag, byte[] payload) {
        int seq;
        synchronized (lock) {
            seq = nextSeq++ & 0xff;
        }
        List<byte[]> frames = BleProtocol.framePb(payload, sid, flag, seq);
        return bleManager.writeFrames(
            address,
            BleProtocol.WRITE_CHAR_UUID,
            frames,
            ConnectionOptions.WRITE_TYPE,
            ConnectionOptions.WRITE_TIMEOUT_MS);
    }

    private void startHeartbeat() {
        stopHeartbeat();
        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(runnable -> {
            Thread t = new Thread(runnable, "faceclaw-flash-hb");
            t.setDaemon(true);
            return t;
        });
        heartbeatExecutor = executor;
        executor.scheduleWithFixedDelay(
            this::sendHeartbeat, HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_MS, TimeUnit.MILLISECONDS);
    }

    private void sendHeartbeat() {
        if (finished || cancelled) {
            return;
        }
        try {
            byte[] heartbeat = BleProtocol.buildHeartbeat(allocMagic());
            if (rightConnected) {
                writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, heartbeat);
            }
            if (leftConnected) {
                writeFrame(leftAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, heartbeat);
            }
        } catch (Exception e) {
            Log.w(TAG, "heartbeat failed: " + e.getMessage());
        }
    }

    private void stopHeartbeat() {
        ScheduledExecutorService executor = heartbeatExecutor;
        heartbeatExecutor = null;
        if (executor != null) {
            executor.shutdownNow();
        }
    }

    private void sendShutdownBoth() {
        byte[] shutdown = BleProtocol.buildShutdown(allocMagic(), 0);
        if (rightConnected) {
            writeFrame(rightAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, shutdown);
        }
        if (leftConnected) {
            writeFrame(leftAddress, BleProtocol.SID_EVENHUB, BleProtocol.FLAG_REQUEST, shutdown);
        }
    }

    private void teardown() {
        finished = true;
        stopHeartbeat();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
        rightConnected = false;
        leftConnected = false;
    }

    @Override
    public void onNotification(String address, String characteristicUuid, byte[] data) {
        if (!BleProtocol.NOTIFY_CHAR_UUID.equalsIgnoreCase(characteristicUuid)) {
            return;
        }
        BleProtocol.ParsedFrame frame = BleProtocol.parseFrame(data);
        if (!frame.ok) {
            return;
        }
        if (frame.flag == BleProtocol.FLAG_NOTIFY || frame.flag == BleProtocol.FLAG_NOTIFY_ALT) {
            // Async events (taps/selections) only ever come from the right arm.
            if (address.equalsIgnoreCase(rightAddress)) {
                handleEvent(frame);
            }
            return;
        }
        if (frame.msgSeq >= 0) {
            CountDownLatch latch = pendingAcks.get(ackKey(frame.sid, frame.msgSeq));
            if (latch != null) {
                latch.countDown();
            }
        }
    }

    private void handleEvent(BleProtocol.ParsedFrame frame) {
        BleProtocol.ListSelection selection = BleProtocol.parseListSelection(frame);
        if (selection == null || !LIST_NAME.equals(selection.containerName)) {
            return;
        }
        // Only a confirmed click is a decision; scroll/highlight changes are ignored.
        if (selection.eventType != BleProtocol.EVENT_CLICK) {
            return;
        }
        boolean yes = selection.itemIndex == 1
            || (selection.itemName != null && selection.itemName.toLowerCase().startsWith("yes"));
        synchronized (lock) {
            if (finished) {
                return;
            }
            finished = true;
            approved = yes;
        }
        emitLog("selection: " + (yes ? "flash" : "cancel") + " (index " + selection.itemIndex + ")");
        selectionLatch.countDown();
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        if (connected) {
            return;
        }
        if (address.equalsIgnoreCase(rightAddress)) {
            rightConnected = false;
            synchronized (lock) {
                if (!finished && !cancelled) {
                    rightLost = true;
                    finished = true;
                    selectionLatch.countDown();
                }
            }
        } else if (address.equalsIgnoreCase(leftAddress)) {
            leftConnected = false;
        }
    }

    private int allocMagic() {
        synchronized (lock) {
            int magic = nextMagic;
            nextMagic = nextMagic >= 255 ? 100 : nextMagic + 1;
            return magic;
        }
    }

    private static String ackKey(int sid, int magic) {
        return sid + ":" + magic;
    }

    private void emitLog(String line) {
        Log.i(TAG, line);
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onLog(line);
            }
        });
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitResult(boolean approvedResult) {
        mainHandler.post(() -> {
            FaceclawFlashPromptListener current = listener;
            if (current != null) {
                current.onResult(approvedResult);
            }
        });
    }
}
