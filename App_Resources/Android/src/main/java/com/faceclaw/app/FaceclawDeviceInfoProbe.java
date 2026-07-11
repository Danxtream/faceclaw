package com.faceclaw.app;

import android.bluetooth.BluetoothGatt;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Connects to the glasses (stock-firmware compatible), reads the device-info /
 * settings response, and reports the firmware versions plus the CFW capability
 * string (empty on stock firmware). Used by onboarding to decide whether to
 * flash. Reuses FaceclawBleManager + BleProtocol; owns its own connection and
 * runs on a single worker thread. Shows nothing on the lens.
 */
public class FaceclawDeviceInfoProbe implements FaceclawBleListener {
    private static final String TAG = "FaceclawDeviceInfo";
    private static final int QUERY_TIMEOUT_MS = 4_000;

    private final Context context;
    private final String rightAddress;
    private final FaceclawBleManager bleManager;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private final Object lock = new Object();
    private int nextSeq = 0x40;
    private int nextMagic = 100;

    private int awaitSid = -1;
    private int awaitMagic = -1;
    private byte[] awaitPb = null;
    private CountDownLatch awaitLatch = null;

    private volatile FaceclawDeviceInfoProbeListener listener;
    private volatile Thread worker;
    private volatile boolean cancelled = false;

    public FaceclawDeviceInfoProbe(Context context, String rightAddress) {
        this.context = context.getApplicationContext();
        this.rightAddress = rightAddress == null ? "" : rightAddress;
        this.bleManager = new FaceclawBleManager(this.context);
        this.bleManager.setListener(this);
    }

    public void setListener(FaceclawDeviceInfoProbeListener listener) {
        this.listener = listener;
    }

    public void start() {
        synchronized (lock) {
            if (worker != null) {
                return;
            }
            worker = new Thread(this::run, "faceclaw-device-info");
            worker.start();
        }
    }

    public void cancel() {
        cancelled = true;
        Thread w = worker;
        if (w != null) {
            w.interrupt();
        }
    }

    public void close() {
        cancel();
        try {
            bleManager.close();
        } catch (Exception ignored) {
        }
    }

    private void run() {
        try {
            if (rightAddress.trim().isEmpty()) {
                emitError("No right-arm address configured.");
                return;
            }

            emitState("connecting", "");
            connectArm(rightAddress);
            if (cancelled) {
                emitError("Cancelled.");
                return;
            }

            emitState("querying", "");
            // Session prelude, then a settings/device-info read (both arms'
            // versions and the CFW capability string ride back in one response).
            if (writeAndAwaitAck(rightAddress, BleProtocol.PRELUDE_ACK_SID, BleProtocol.FLAG_REQUEST,
                    BleProtocol.PRELUDE_ACK_MAGIC, BleProtocol.PRELUDE_F5872_PAYLOAD,
                    ConnectionOptions.PRELUDE_TIMEOUT_MS) == null) {
                throw new IllegalStateException("session prelude not acked");
            }

            int magic = allocMagic();
            byte[] ack = writeAndAwaitAck(rightAddress, BleProtocol.SID_UI_SETTING, BleProtocol.FLAG_REQUEST,
                magic, BleProtocol.buildSettingsQuery(magic), QUERY_TIMEOUT_MS);
            if (ack == null) {
                throw new IllegalStateException("no response to the device-info query");
            }

            BleProtocol.FirmwareInfo info = BleProtocol.parseSettingsFirmwareInfo(ack);
            String left = info == null ? "" : info.leftVersion;
            String right = info == null ? "" : info.rightVersion;
            String caps = info == null ? "" : info.capabilities;
            emitLog("device-info: L=" + left + " R=" + right + " caps=[" + caps + "]");
            emitResult(left, right, caps);
        } catch (Exception e) {
            String message = cancelled ? "Cancelled." : (e.getMessage() == null ? e.toString() : e.getMessage());
            emitError(message);
        } finally {
            try {
                bleManager.close();
            } catch (Exception ignored) {
            }
        }
    }

    private void connectArm(String address) {
        if (!bleManager.connect(address, ConnectionOptions.CONNECT_TIMEOUT_MS)) {
            throw new IllegalStateException("connect failed");
        }
        bleManager.requestConnectionPriority(address, BluetoothGatt.CONNECTION_PRIORITY_HIGH);
        bleManager.requestMtu(address, ConnectionOptions.DESIRED_MTU, ConnectionOptions.CONNECT_TIMEOUT_MS);
        if (!bleManager.discoverServices(address, ConnectionOptions.SERVICES_TIMEOUT_MS)) {
            throw new IllegalStateException("service discovery failed");
        }
        if (!bleManager.enableNotifications(address, BleProtocol.NOTIFY_CHAR_UUID, true, ConnectionOptions.DESCRIPTOR_TIMEOUT_MS)) {
            throw new IllegalStateException("could not subscribe to notifications");
        }
    }

    private byte[] writeAndAwaitAck(String address, int sid, int flag, int magic, byte[] payload, int timeoutMs)
            throws InterruptedException {
        CountDownLatch latch = new CountDownLatch(1);
        synchronized (lock) {
            awaitSid = sid;
            awaitMagic = magic;
            awaitPb = null;
            awaitLatch = latch;
        }
        int seq;
        synchronized (lock) {
            seq = nextSeq++ & 0xff;
        }
        List<byte[]> frames = BleProtocol.framePb(payload, sid, flag, seq);
        boolean written = bleManager.writeFrames(
            address, BleProtocol.WRITE_CHAR_UUID, frames, ConnectionOptions.WRITE_TYPE, ConnectionOptions.WRITE_TIMEOUT_MS);
        if (!written) {
            synchronized (lock) {
                awaitLatch = null;
            }
            return null;
        }
        boolean acked = latch.await(timeoutMs, TimeUnit.MILLISECONDS);
        synchronized (lock) {
            awaitLatch = null;
            return acked ? awaitPb : null;
        }
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
            return; // async event, not an ack
        }
        synchronized (lock) {
            if (awaitLatch != null && frame.sid == awaitSid && frame.msgSeq == awaitMagic) {
                awaitPb = frame.pb;
                awaitLatch.countDown();
            }
        }
    }

    @Override
    public void onConnectionStateChange(String address, boolean connected) {
        if (!connected) {
            Log.i(TAG, "disconnected: " + address);
        }
    }

    private int allocMagic() {
        synchronized (lock) {
            int magic = nextMagic;
            nextMagic = nextMagic >= 255 ? 100 : nextMagic + 1;
            return magic;
        }
    }

    private void emitLog(String line) {
        Log.i(TAG, line);
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onLog(line);
            }
        });
    }

    private void emitState(String state, String detail) {
        final String safeDetail = detail == null ? "" : detail;
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onState(state, safeDetail);
            }
        });
    }

    private void emitResult(String left, String right, String caps) {
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onResult(left, right, caps);
            }
        });
    }

    private void emitError(String message) {
        final String safeMessage = message == null ? "" : message;
        mainHandler.post(() -> {
            FaceclawDeviceInfoProbeListener current = listener;
            if (current != null) {
                current.onError(safeMessage);
            }
        });
    }
}
