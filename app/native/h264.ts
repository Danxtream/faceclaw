declare const com: any;
declare const global: any;

const H264_POLL_INTERVAL_MS = 10;
const H264_OPERATION_TIMEOUT_MS = 5_000;

function activeCommunicator(): any {
  if (!global.isAndroid) return null;

  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

function pause(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function pollUntil(
  poll: () => number,
  timeoutMs = H264_OPERATION_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const status = Number(poll());
    if (status > 0) return true;
    if (status < 0) return false;
    if (Date.now() >= deadline) return false;
    await pause(H264_POLL_INTERVAL_MS);
  }
}

export async function sendH264Payload(payload: Uint8Array): Promise<boolean> {
  const active = activeCommunicator();

  if (!active) {
    throw new Error("G2 communicator is not connected");
  }

  const snapshot = new Uint8Array(payload);
  const transferId = Number(active.enqueueH264Control(snapshot.buffer));

  if (transferId <= 0) return false;
  return pollUntil(() => Number(active.pollH264Transfer(transferId)));
}

export function h264BeginStream(streamId: number): boolean {
  const active = activeCommunicator();

  if (!active) {
    throw new Error("G2 communicator is not connected");
  }

  return Boolean(active.beginH264Stream(streamId | 0));
}

export async function h264Drain(): Promise<boolean> {
  const active = activeCommunicator();

  if (!active) {
    throw new Error("G2 communicator is not connected");
  }

  return pollUntil(() => Number(active.pollH264Drain()));
}

export function h264StreamSummary(): string {
  const active = activeCommunicator();

  if (!active) {
    throw new Error("G2 communicator is not connected");
  }

  return String(active.getH264StreamSummary());
}

/** Latest firmware-reported physically presented sequence for the active stream. */
export function h264PresentedSequence(): number {
  const active = activeCommunicator();
  if (!active) return 0;
  return Number(active.getH264PresentedSequence()) >>> 0;
}

export async function h264EndStream(): Promise<boolean> {
  const active = activeCommunicator();

  if (!active) {
    return false;
  }

  const requested = Number(active.requestH264End());
  if (requested > 0) return true;
  if (requested < 0) return false;
  return pollUntil(() => Number(active.pollH264End()));
}

function writeUint32Le(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff;
  target[offset + 1] = (value >>> 8) & 0xff;
  target[offset + 2] = (value >>> 16) & 0xff;
  target[offset + 3] = (value >>> 24) & 0xff;
}


/**
 * Select the BLE PHY used by an active Video session.
 *
 * 1M restores the stock G2 controller feature mask.
 * 2M temporarily enables LE 2M through Packetcraft 0xFFF2,
 * then asks both links to switch PHY.
 */
export async function h264SetBlePhy2m(
  enabled: boolean,
): Promise<boolean> {
  const active = activeCommunicator();

  if (!active) {
    return false;
  }

  const requestId =
    Number(
      active.requestVideoBlePhy(
        enabled ? 2 : 1,
      ),
    );

  if (requestId <= 0) {
    return false;
  }

  return pollUntil(
    () =>
      Number(
        active.pollVideoBlePhy(
          requestId,
        ),
      ),
    H264_OPERATION_TIMEOUT_MS,
  );
}

export function h264Start(streamId: number): Promise<boolean> {
  const payload = new Uint8Array(6);
  payload[0] = 11;
  payload[1] = 1;
  writeUint32Le(payload, 2, streamId);
  return sendH264Payload(payload);
}

export function h264Reset(): Promise<boolean> {
  return sendH264Payload(
    new Uint8Array([11, 2]),
  );
}

export function h264Stop(): Promise<boolean> {
  return sendH264Payload(
    new Uint8Array([11, 0]),
  );
}

/** Exercise the mode-11 display path without allocating the decoder. */
export function h264Probe(): Promise<boolean> {
  return sendH264Payload(
    new Uint8Array([11, 4]),
  );
}

/** Replace the display with the firmware's current H.264 diagnostic state. */
export function h264Status(): Promise<boolean> {
  return sendH264Payload(
    new Uint8Array([11, 5]),
  );
}

/** Per-lens asymmetric markers used to identify lens routing and flips. */
export function h264OrientationProbe(): Promise<boolean> {
  return sendH264Payload(new Uint8Array([11, 7]));
}

/** Ask the master lens to emit its current sequence counters without repainting. */
export function h264Telemetry(): Promise<boolean> {
  return sendH264Payload(new Uint8Array([11, 8]));
}

/** Select native output or nearest-neighbor 2x presentation for this stream. */
export function h264SetScale2x(enabled: boolean): Promise<boolean> {
  return sendH264Payload(new Uint8Array([11, 9, enabled ? 1 : 0]));
}

/** Configure the firmware's lockstep deferred-callback period for this stream. */
export function h264SetFrameInterval(frameDurationMs: number): Promise<boolean> {
  const intervalMs = Math.max(16, Math.min(1000, Math.round(frameDurationMs)));
  return sendH264Payload(
    new Uint8Array([11, 10, intervalMs & 0xff, (intervalMs >>> 8) & 0xff]),
  );
}

/** Paint or clear the firmware-owned paused playback controls. */
export function h264PauseOverlay(
  paused: boolean,
  positionMs: number,
  durationMs: number,
  selection: number,
): Promise<boolean> {
  if (!Number.isInteger(selection) || selection < 0 || selection > 4) {
    throw new Error(`Invalid H264 pause-overlay selection: ${selection}`);
  }
  const payload = new Uint8Array(12);
  payload[0] = 11;
  payload[1] = 11;
  payload[2] = paused ? 1 : 0;
  payload[3] = selection;
  writeUint32Le(payload, 4, Math.max(0, Math.round(positionMs)) >>> 0);
  writeUint32Le(payload, 8, Math.max(0, Math.round(durationMs)) >>> 0);
  return sendH264Payload(payload);
}

export function h264DecodeNal(nal: Uint8Array): Promise<boolean> {
  const payload = new Uint8Array(2 + nal.length);

  payload[0] = 11;
  payload[1] = 3;
  payload.set(nal, 2);

  return sendH264Payload(payload);
}

/** Queue a session-tagged NAL through the decoder-confirmed logical window. */
export async function h264QueueNal(
  nal: Uint8Array,
  streamId: number,
  sequence: number,
): Promise<boolean> {
  const active = activeCommunicator();

  if (!active) {
    throw new Error("G2 communicator is not connected");
  }

  const payload = new Uint8Array(10 + nal.length);
  payload[0] = 11;
  payload[1] = 6;
  writeUint32Le(payload, 2, streamId);
  writeUint32Le(payload, 6, sequence);
  payload.set(nal, 10);

  const deadline = Date.now() + H264_OPERATION_TIMEOUT_MS;
  while (true) {
    const status = Number(active.tryQueueH264Payload(payload.buffer));
    if (status > 0) return true;
    if (status < 0 || Date.now() >= deadline) return false;
    await pause(H264_POLL_INTERVAL_MS);
  }
}
