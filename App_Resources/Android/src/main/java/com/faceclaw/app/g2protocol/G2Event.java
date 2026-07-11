package com.faceclaw.app;

public final class G2Event {
    final String kind;
    final String containerName;
    final int eventType;
    final int eventSource;
    final int systemExitReasonCode;
    // IMU_Report_Data (Sys_ItemEvent.IMUData), populated when the firmware
    // attaches an accelerometer reading to a sys-event.
    final boolean hasImu;
    final double imuX;
    final double imuY;
    final double imuZ;

    public G2Event(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode) {
        this(kind, containerName, eventType, eventSource, systemExitReasonCode, false, 0, 0, 0);
    }

    public G2Event(String kind, String containerName, int eventType, int eventSource, int systemExitReasonCode,
                   boolean hasImu, double imuX, double imuY, double imuZ) {
        this.kind = kind;
        this.containerName = containerName;
        this.eventType = eventType;
        this.eventSource = eventSource;
        this.systemExitReasonCode = systemExitReasonCode;
        this.hasImu = hasImu;
        this.imuX = imuX;
        this.imuY = imuY;
        this.imuZ = imuZ;
    }

    public static G2Event decode(BleProtocol.ParsedFrame frame) {
        byte[] pb = BleProtocol.stripTrailingCrc(frame.pb);
        byte[] deviceEvent = BleProtocol.readFieldBytes(pb, 13);
        if (deviceEvent == null) {
            return null;
        }

        byte[] listEvent = BleProtocol.readFieldBytes(deviceEvent, 1);
        if (listEvent != null) {
            return new G2Event(
                "list-click",
                BleProtocol.readStringFieldValue(listEvent, 2),
                BleProtocol.readVarintFieldValue(listEvent, 5, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] textEvent = BleProtocol.readFieldBytes(deviceEvent, 2);
        if (textEvent != null) {
            return new G2Event(
                "text-click",
                BleProtocol.readStringFieldValue(textEvent, 2),
                BleProtocol.readVarintFieldValue(textEvent, 3, BleProtocol.EVENT_CLICK),
                0,
                0
            );
        }

        byte[] sysEvent = BleProtocol.readFieldBytes(deviceEvent, 3);
        if (sysEvent != null) {
            int eventType = BleProtocol.readVarintFieldValue(sysEvent, 1, BleProtocol.EVENT_CLICK);
            int eventSource = BleProtocol.readVarintFieldValue(sysEvent, 2, 0);
            int exitReason = BleProtocol.readVarintFieldValue(sysEvent, 4, 0);
            // IMUData (field 3) is IMU_Report_Data { double x=1, y=2, z=3 }. It
            // may accompany any sys-event, or arrive as a standalone
            // IMU_DATA_REPORT sample.
            byte[] imu = BleProtocol.readFieldBytes(sysEvent, 3);
            if (imu != null) {
                double x = BleProtocol.readFloatFieldValue(imu, 1, 0);
                double y = BleProtocol.readFloatFieldValue(imu, 2, 0);
                double z = BleProtocol.readFloatFieldValue(imu, 3, 0);
                return new G2Event("sys-event", "", eventType, eventSource, exitReason, true, x, y, z);
            }
            return new G2Event("sys-event", "", eventType, eventSource, exitReason);
        }
        return null;
    }

    private static String hex(byte[] data) {
        if (data == null) {
            return "null";
        }
        StringBuilder sb = new StringBuilder(data.length * 2);
        for (byte b : data) {
            sb.append(String.format("%02x", b & 0xff));
        }
        return sb.toString();
    }

}
