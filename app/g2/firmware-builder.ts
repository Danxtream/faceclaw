/**
 * Builds the Faceclaw custom firmware on-device: downloads the stock Even
 * Realities G2 2.2.6.10 image from Even's CDN, verifies its SHA-256, applies
 * the committed byte-patch set (cfw-patches.ts), verifies the patched SHA-256,
 * and writes the result to app storage.
 *
 * This mirrors g2flash/build_cfw.sh + patches/apply_patches.py exactly (same
 * URL, same pinned hashes, same offset/old/new patch semantics), so a
 * successful run reproduces the reviewed image byte-for-byte. It does NOT flash
 * anything — producing and verifying the image is the whole job here.
 */
import { knownFolders } from "@nativescript/core";

import { CFW_PATCH_SET, FirmwarePatchOp } from "./firmware/cfw-patches";

declare const com: any;

const FIRMWARE_URL = "https://cdn.evenreal.co/firmware/e28738432d7b612d625331b00383149b.bin";
const CFW_OUTPUT_FILENAME = "g2_2.2.6.10_cfw.bin";
const STOCK_OUTPUT_FILENAME = "g2_2.2.6.10.bin";

export type FirmwareProgress =
  | { phase: "downloading" }
  | { phase: "verifying-base" }
  | { phase: "patching"; applied: number; total: number }
  | { phase: "verifying-output" }
  | { phase: "writing" }
  | { phase: "done"; path: string; bytes: number };

export type BuiltFirmware = {
  path: string;
  bytes: number;
  sha256: string;
};

export class FirmwareBuildError extends Error {}

/**
 * Download → verify → patch → verify → persist. Rejects with a
 * FirmwareBuildError carrying a human-readable message if any hash check or the
 * download fails. `onProgress` is optional and purely for UI.
 */
export async function buildCustomFirmware(
  onProgress?: (progress: FirmwareProgress) => void,
): Promise<BuiltFirmware> {
  const report = (progress: FirmwareProgress) => {
    try {
      onProgress?.(progress);
    } catch {
      // progress reporting must never break the build
    }
  };

  const base = await downloadAndVerifyBase(report);

  const patched = applyPatches(new Uint8Array(base), CFW_PATCH_SET.patches, (applied, total) =>
    report({ phase: "patching", applied, total }),
  );

  report({ phase: "verifying-output" });
  const outBuffer = tightBuffer(patched);
  const outSha = sha256Hex(outBuffer);
  if (outSha !== CFW_PATCH_SET.outputSha256) {
    throw new FirmwareBuildError(
      `Patched firmware failed verification.\nexpected ${CFW_PATCH_SET.outputSha256}\ngot      ${outSha}`,
    );
  }

  report({ phase: "writing" });
  const path = `${knownFolders.documents().path}/${CFW_OUTPUT_FILENAME}`;
  writeFile(path, outBuffer);

  report({ phase: "done", path, bytes: patched.length });
  return { path, bytes: patched.length, sha256: outSha };
}

/**
 * Download and verify the unmodified stock firmware (no patches applied) and
 * persist it. Used to un-install the custom firmware by reflashing the original
 * image the CFW was built from.
 */
export async function buildStockFirmware(
  onProgress?: (progress: FirmwareProgress) => void,
): Promise<BuiltFirmware> {
  const report = (progress: FirmwareProgress) => {
    try {
      onProgress?.(progress);
    } catch {
      // progress reporting must never break the build
    }
  };

  const base = await downloadAndVerifyBase(report);

  report({ phase: "writing" });
  const path = `${knownFolders.documents().path}/${STOCK_OUTPUT_FILENAME}`;
  writeFile(path, base);

  report({ phase: "done", path, bytes: base.byteLength });
  return { path, bytes: base.byteLength, sha256: CFW_PATCH_SET.baseSha256 };
}

async function downloadAndVerifyBase(report: (progress: FirmwareProgress) => void): Promise<ArrayBuffer> {
  report({ phase: "downloading" });
  const base = await downloadFirmware();

  report({ phase: "verifying-base" });
  const baseSha = sha256Hex(base);
  if (baseSha !== CFW_PATCH_SET.baseSha256) {
    throw new FirmwareBuildError(
      `Downloaded stock firmware failed verification.\nexpected ${CFW_PATCH_SET.baseSha256}\ngot      ${baseSha}`,
    );
  }
  return base;
}

async function downloadFirmware(): Promise<ArrayBuffer> {
  let response: Response;
  try {
    response = await fetch(FIRMWARE_URL);
  } catch (error) {
    throw new FirmwareBuildError(`Could not reach Even's firmware CDN: ${(error as Error)?.message ?? error}`);
  }
  if (!response.ok) {
    throw new FirmwareBuildError(`Firmware download failed (HTTP ${response.status}).`);
  }
  return response.arrayBuffer();
}

/**
 * Replay the committed patch set onto `base`, returning the patched bytes. Each
 * op writes `new` at `offset` after checking the bytes there equal `old`; an op
 * with empty `old` appends at end-of-file (offset must equal current length).
 * Idempotent: an op whose target already equals `new` is skipped. Mirrors
 * apply_patches.py:apply_ops.
 */
function applyPatches(
  base: Uint8Array,
  ops: FirmwarePatchOp[],
  onStep?: (applied: number, total: number) => void,
): Uint8Array {
  let buf = base;
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const oldBytes = hexToBytes(op.old ?? "");
    const newBytes = hexToBytes(op.new);
    const off = op.offset;
    const tag = `patch #${i} @ 0x${off.toString(16)}${op.desc ? ` (${op.desc})` : ""}`;

    if (oldBytes.length > 0) {
      const cur = buf.subarray(off, off + oldBytes.length);
      if (bytesEqual(cur, newBytes) && !bytesEqual(cur, oldBytes)) {
        onStep?.(i + 1, ops.length);
        continue; // already applied
      }
      if (!bytesEqual(cur, oldBytes)) {
        throw new FirmwareBuildError(
          `${tag}: unexpected bytes in stock image (found ${bytesToHex(cur)}, expected ${op.old}). ` +
            `The downloaded image is not the stock base this patch set targets.`,
        );
      }
      buf.set(newBytes, off);
    } else {
      const end = off + newBytes.length;
      if (off <= buf.length && end <= buf.length && bytesEqual(buf.subarray(off, end), newBytes)) {
        onStep?.(i + 1, ops.length);
        continue; // already applied
      }
      if (off !== buf.length) {
        throw new FirmwareBuildError(
          `${tag}: append expects offset 0x${off.toString(16)} to equal current length 0x${buf.length.toString(16)}.`,
        );
      }
      buf = concatBytes(buf, newBytes);
    }
    onStep?.(i + 1, ops.length);
  }
  return buf;
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) {
    throw new FirmwareBuildError(`odd-length hex string: ${hex}`);
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0");
  }
  return hex;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** Return an ArrayBuffer holding exactly `bytes`' contents (no shared slack). */
function tightBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength) {
    return bytes.buffer;
  }
  return bytes.slice().buffer;
}

/** SHA-256 hex digest of an ArrayBuffer, via Android's MessageDigest. */
function sha256Hex(buffer: ArrayBuffer): string {
  return String(com.faceclaw.app.FaceclawFirmwareUtil.sha256Hex(buffer));
}

/** Write an ArrayBuffer's bytes to `path`, via a native FileChannel write. */
function writeFile(path: string, buffer: ArrayBuffer): void {
  com.faceclaw.app.FaceclawFirmwareUtil.writeFile(path, buffer);
}
