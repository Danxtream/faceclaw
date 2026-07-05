import type { Terminal as XtermTerminal } from "@xterm/headless";

// xterm-headless expects a few browser globals (navigator for platform
// sniffing, window for timer/scheduling lookups) that the NativeScript
// runtime doesn't define. Provide minimal stand-ins before the library is
// evaluated (hence require, not a hoisted import).
const runtimeGlobal = globalThis as any;
if (typeof runtimeGlobal.navigator === "undefined") {
  runtimeGlobal.navigator = {
    userAgent: "NativeScript",
    platform: "Android",
    language: "en",
    languages: ["en"],
  };
}
if (typeof runtimeGlobal.window === "undefined") {
  runtimeGlobal.window = runtimeGlobal;
}
if (typeof runtimeGlobal.self === "undefined") {
  runtimeGlobal.self = runtimeGlobal;
}
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { Terminal } = require("@xterm/headless") as typeof import("@xterm/headless");

/**
 * Headless terminal emulator for g2mirror streams: feed it the raw
 * VT100/xterm bytes from snapshot/output messages and read back the visible
 * text grid. Formatting (color/bold/inverse) is deliberately dropped for
 * now — we only mirror the text.
 */
export class TerminalEmulator {
  private readonly term: XtermTerminal;

  constructor(
    readonly cols: number,
    readonly rows: number,
  ) {
    this.term = new Terminal({
      cols,
      rows,
      scrollback: 0,
      allowProposedApi: true,
    });
  }

  /**
   * Apply terminal bytes. onProcessed fires once the emulator has actually
   * parsed them (xterm buffers writes internally), so schedule repaints there.
   */
  write(data: Uint8Array, onProcessed: () => void): void {
    this.term.write(data, onProcessed);
  }

  /** Full reset; snapshots are defined as repainting from a cleared screen. */
  reset(): void {
    this.term.reset();
  }

  visibleLines(): string[] {
    const buffer = this.term.buffer.active;
    const lines: string[] = [];
    for (let row = 0; row < this.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row);
      lines.push(line ? line.translateToString(true) : "");
    }
    return lines;
  }

  cursor(): { x: number; y: number } {
    const buffer = this.term.buffer.active;
    return { x: buffer.cursorX, y: buffer.cursorY };
  }
}
