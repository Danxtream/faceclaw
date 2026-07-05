package com.faceclaw.app;
import android.bluetooth.BluetoothGattCharacteristic;

public class ConnectionOptions {
    public static final int WRITE_TYPE = BluetoothGattCharacteristic.WRITE_TYPE_NO_RESPONSE;
    public static final int DESIRED_MTU = 512;

    public static final int CONNECT_TIMEOUT_MS = 5_000;
    public static final int SERVICES_TIMEOUT_MS = 5_000;
    public static final int DESCRIPTOR_TIMEOUT_MS = 5_000;
    public static final int RING_DESIRED_MTU = 247;
    public static final int RING_RECONNECT_DELAY_MS = 2_000;
    public static final int WRITE_TIMEOUT_MS = 2_000;
    public static final int PRELUDE_TIMEOUT_MS = 2_000;
    public static final int ACK_TIMEOUT_MS = 3_500;
    public static final int HEARTBEAT_FAILURE_DEADLINE_MS = 10_000;
    public static final int HEARTBEAT_READY_MS = 4_000;
    public static final int HEARTBEAT_URGENT_MS = 6_000;
    public static final int BATTERY_REFRESH_INTERVAL_MS = 5 * 60_000;
    public static final int BATTERY_INPUT_QUIET_MS = 5_000;
    // Poll cadence while in charging mode; also bounds how quickly we notice
    // the glasses coming back out of the case.
    public static final int CHARGING_BATTERY_POLL_MS = 30_000;
    public static final int IMAGE_FRAGMENT_SIZE = 3800;
    public static final int IMAGE_RETRY_DELAY_MS = 2_000;
    public static final int MAX_CONSECUTIVE_ACK_TIMEOUTS = 8;
    public static final int EVEN_APP_WRITE_FAILURE_WINDOW_MS = 15_000;
    public static final int IDLE_SLEEP_MS = 100;
    public static final int RECONNECT_DELAY_MS = 2_000;

    final boolean sendImagesToLeft = true;
    final boolean skipSessionIds = true;
    final int WINDOW_SIZE = 1;
    // Send changed-region (mode 3 bounding box) updates instead of full frames
    // when the previous frame is known to be displayed. Requires firmware with
    // the experimental bbox-incremental mode. Disabled: the firmware-side
    // display buffer is not always the previous frame (occasionally two frames
    // back, apparently display-driver buffer swapping), so partial updates
    // composite onto stale content per-lens. Re-enable once the firmware
    // guarantees the compositing base.
    final boolean INCREMENTAL_FRAMES = false;
}
