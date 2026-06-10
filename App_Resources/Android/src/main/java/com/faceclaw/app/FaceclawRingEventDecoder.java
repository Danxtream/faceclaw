package com.faceclaw.app;

import java.util.Locale;

final class FaceclawRingEventDecoder {
    private FaceclawRingEventDecoder() {
    }

    static DirectRingEvent decode(byte[] raw) {
        if (raw == null || raw.length == 0) {
            return null;
        }

        DirectRingEvent chargerGesture = decodeChargerGesture(raw);
        if (chargerGesture != null) {
            return chargerGesture;
        }

        return decodeDirectGesture(raw);
    }

    private static DirectRingEvent decodeChargerGesture(byte[] raw) {
        if (raw.length != 11) {
            return null;
        }
        if (u8(raw[0]) != 0x00 || u8(raw[1]) != 0x09 || u8(raw[2]) != 0x61 || u8(raw[3]) != 0x00) {
            return null;
        }

        int code = u8(raw[4]);
        int param = u8(raw[5]) | (u8(raw[6]) << 8);
        long tick = (u8(raw[7]) | (u8(raw[8]) << 8) | (u8(raw[9]) << 16) | (u8(raw[10]) << 24)) & 0xffffffffL;
        String detail = String.format(Locale.US, "code=0x%02x(%s) param=0x%04x tick=%d", code, chargerCodeName(code), param, tick);

        switch (code) {
            case 0x00:
                return event(BleProtocol.EVENT_RING_LONG_PRESS, "LONG_PRESS", detail);
            case 0x01:
                return event(BleProtocol.EVENT_CLICK, "TAP", detail);
            case 0x02:
                return event(BleProtocol.EVENT_DOUBLE_CLICK, "DOUBLE_TAP", detail);
            case 0x04:
                return event(BleProtocol.EVENT_SCROLL_TOP, "SWIPE_UP", detail);
            case 0x05:
                return event(BleProtocol.EVENT_SCROLL_BOTTOM, "SWIPE_DOWN", detail);
            case 0x08:
                return event(BleProtocol.EVENT_RING_LONG_PRESS_RELEASE, "LONG_PRESS_RELEASE", detail);
            default:
                return null;
        }
    }

    private static DirectRingEvent decodeDirectGesture(byte[] raw) {
        if (raw.length != 3 || u8(raw[0]) != 0xff) {
            return null;
        }

        int type = u8(raw[1]);
        int param = u8(raw[2]);
        String detail = String.format(Locale.US, "type=0x%02x param=0x%02x", type, param);

        if (type == 0x03 && param == 0x20) {
            return event(BleProtocol.EVENT_RING_LONG_PRESS, "HOLD", detail);
        }
        if (type == 0x04 && param == 0x01) {
            return event(BleProtocol.EVENT_CLICK, "TAP_SINGLE", detail);
        }
        if (type == 0x04 && param == 0x02) {
            return event(BleProtocol.EVENT_DOUBLE_CLICK, "TAP_DOUBLE", detail);
        }
        if (type == 0x05) {
            if (param <= 0x01) {
                return event(BleProtocol.EVENT_SCROLL_BOTTOM, "SWIPE_FORWARD", detail);
            }
            return event(BleProtocol.EVENT_SCROLL_TOP, "SWIPE_BACKWARD", detail);
        }

        return null;
    }

    private static DirectRingEvent event(int eventType, String label, String detail) {
        G2Event event = new G2Event(
            "sys-event",
            "",
            eventType,
            BleProtocol.EVENT_SOURCE_RING,
            0
        );
        return new DirectRingEvent(event, label, detail);
    }

    private static String chargerCodeName(int code) {
        switch (code) {
            case 0x00:
                return "LONG_PRESS";
            case 0x01:
                return "TAP";
            case 0x02:
                return "DOUBLE_TAP";
            case 0x04:
                return "SWIPE_UP";
            case 0x05:
                return "SWIPE_DOWN";
            case 0x08:
                return "LONG_PRESS_RELEASE";
            default:
                return "unknown";
        }
    }

    private static int u8(byte value) {
        return value & 0xff;
    }

    static final class DirectRingEvent {
        final G2Event event;
        final String label;
        final String detail;

        DirectRingEvent(G2Event event, String label, String detail) {
            this.event = event;
            this.label = label;
            this.detail = detail;
        }
    }
}
