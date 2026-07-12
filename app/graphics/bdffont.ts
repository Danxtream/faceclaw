import { knownFolders } from "@nativescript/core";
import { getStringSetting, onSettingsStoreChanged } from "~/native/settings-store";

export type Glyph = {
  encoding: number;
  dwidthX: number;
  bbxWidth: number;
  bbxHeight: number;
  bbxX: number;
  bbxY: number;
  bitmapRows: number[];
};

export class BdfFont {
  readonly ascent: number;
  readonly descent: number;
  readonly lineHeight: number;
  readonly defaultChar: number;
  /**
   * Font consulted for code points this font has no glyph for. Used so a
   * partial-coverage face (e.g. TerminusV, which only ships ISO-8859-1) can
   * borrow glyphs from a full-coverage face of the same pixel height. The
   * fallback's glyphs are drawn with *this* font's ascent, so the two must
   * share a baseline (ascent/descent) for the result to line up.
   */
  private readonly fallback?: BdfFont;
  private readonly glyphs: Map<number, Glyph>;

  constructor(opts: {
    ascent: number;
    descent: number;
    defaultChar: number;
    glyphs: Map<number, Glyph>;
    fallback?: BdfFont;
  }) {
    this.ascent = opts.ascent;
    this.descent = opts.descent;
    this.lineHeight = opts.ascent + opts.descent;
    this.defaultChar = opts.defaultChar;
    this.glyphs = opts.glyphs;
    this.fallback = opts.fallback;
  }

  static parse(source: string, opts: { fallback?: BdfFont; minEncoding?: number } = {}): BdfFont {
    const minEncoding = opts.minEncoding ?? 0;
    const lines = source.replace(/\r/g, "").split("\n");
    let ascent = 10;
    let descent = 2;
    let defaultChar = 63;
    const glyphs = new Map<number, Glyph>();

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (line.startsWith("FONT_ASCENT ")) {
        ascent = parseInt(line.slice("FONT_ASCENT ".length), 10);
        continue;
      }
      if (line.startsWith("FONT_DESCENT ")) {
        descent = parseInt(line.slice("FONT_DESCENT ".length), 10);
        continue;
      }
      if (line.startsWith("DEFAULT_CHAR ")) {
        defaultChar = parseInt(line.slice("DEFAULT_CHAR ".length), 10);
        continue;
      }
      if (!line.startsWith("STARTCHAR ")) {
        continue;
      }

      let encoding = -1;
      let dwidthX = 0;
      let bbxWidth = 0;
      let bbxHeight = 0;
      let bbxX = 0;
      let bbxY = 0;
      const bitmapRows: number[] = [];

      for (i = i + 1; i < lines.length; i++) {
        const inner = lines[i]!;
        if (inner.startsWith("ENCODING ")) {
          encoding = parseInt(inner.slice("ENCODING ".length), 10);
          continue;
        }
        if (inner.startsWith("DWIDTH ")) {
          dwidthX = parseInt(inner.slice("DWIDTH ".length).split(/\s+/)[0]!, 10);
          continue;
        }
        if (inner.startsWith("BBX ")) {
          const [w, h, x, y] = inner
            .slice("BBX ".length)
            .split(/\s+/)
            .map((value) => parseInt(value, 10));
          bbxWidth = w!;
          bbxHeight = h!;
          bbxX = x!;
          bbxY = y!;
          continue;
        }
        if (inner === "BITMAP") {
          for (let row = 0; row < bbxHeight && i + 1 < lines.length; row++) {
            const bitmapLine = lines[++i]!;
            bitmapRows.push(parseInt(bitmapLine || "0", 16) || 0);
          }
          continue;
        }
        if (inner === "ENDCHAR") {
          if (encoding >= minEncoding) {
            glyphs.set(encoding, {
              encoding,
              dwidthX: dwidthX || bbxWidth,
              bbxWidth,
              bbxHeight,
              bbxX,
              bbxY,
              bitmapRows,
            });
          }
          break;
        }
      }
    }

    return new BdfFont({ ascent, descent, defaultChar, glyphs, fallback: opts.fallback });
  }

  /** Exact lookup for a single code point, with no default-char substitution. */
  private getExactGlyph(codePoint: number): Glyph | undefined {
    return this.glyphs.get(codePoint) ?? this.fallback?.getExactGlyph(codePoint);
  }

  getGlyph(codePoint: number): Glyph | undefined {
    return (
      this.getExactGlyph(codePoint) ??
      this.glyphs.get(this.defaultChar) ??
      this.glyphs.get(63) ??
      this.fallback?.getGlyph(codePoint)
    );
  }

  hasGlyph(codePoint: number): boolean {
    return this.glyphs.has(codePoint) || (this.fallback?.hasGlyph(codePoint) ?? false);
  }

  measureText(text: string): number {
    let width = 0;
    for (const char of text) {
      width += this.getGlyph(char.codePointAt(0) ?? 32)?.dwidthX ?? 0;
    }
    return width;
  }
}

const embeddedFonts = {
  "terminus12": "fonts/terminus/ter-u12n.bdf",
  "terminus16": "fonts/terminus/ter-u16n.bdf",
  "terminus24": "fonts/terminus/ter-u24n.bdf",
  "terminus32": "fonts/terminus/ter-u32n.bdf",
  // TerminusV is a proportional (variable-width) Terminus derivative that only
  // covers ISO-8859-1. At 12px it shares Terminus's baseline, so we fall back
  // to Terminus 12 for any code point outside Latin-1. minEncoding 32 drops
  // TerminusV's private low-encoding drawing glyphs so control code points fall
  // through to Terminus too.
  "terminusv12": "fonts/terminusv/terv12n.bdf",
} as const;
type EmbeddedFontName = keyof typeof embeddedFonts;

const fontFallbacks: Partial<Record<EmbeddedFontName, EmbeddedFontName>> = {
  terminusv12: "terminus12",
};
const fontMinEncoding: Partial<Record<EmbeddedFontName, number>> = {
  terminusv12: 32,
};

const cachedEmbeddedFonts = new Map<EmbeddedFontName, BdfFont>();

function loadEmbeddedFont(name: EmbeddedFontName): BdfFont {
  const cached = cachedEmbeddedFonts.get(name);
  if (cached) {
    return cached;
  }
  const file = knownFolders.currentApp().getFile(embeddedFonts[name]);
  const text = file.readTextSync();
  const fallbackName = fontFallbacks[name];
  const font = BdfFont.parse(text, {
    fallback: fallbackName ? loadEmbeddedFont(fallbackName) : undefined,
    minEncoding: fontMinEncoding[name],
  });
  cachedEmbeddedFonts.set(name, font);
  return font;
}

export function getFont(font: EmbeddedFontName): BdfFont {
  return loadEmbeddedFont(font);
}

// User-selectable UI typeface. Only the small (12px) font has an alternative,
// since TerminusV ships no larger sizes; medium/large stay Terminus. The
// storage key and values are re-used by the settings UI in dashboard-settings.
export const UI_FONT_SETTING_KEY = "display.uiFont";
export const UI_FONT_VALUES = ["terminus", "terminusv"] as const;
export type UiFontChoice = (typeof UI_FONT_VALUES)[number];

const SMALL_FONT_FOR_CHOICE: Record<UiFontChoice, EmbeddedFontName> = {
  terminus: "terminus12",
  terminusv: "terminusv12",
};

// Reading the setting hits a JNI bridge, and getDefaultSmallFont() is called
// once per menu item per paint, so cache the resolved choice and invalidate it
// when the setting changes (in any isolate).
let cachedSmallFontChoice: UiFontChoice | null = null;
let smallFontListenerInstalled = false;

function currentSmallFontName(): EmbeddedFontName {
  if (!smallFontListenerInstalled) {
    onSettingsStoreChanged((key) => {
      if (key === UI_FONT_SETTING_KEY) cachedSmallFontChoice = null;
    });
    smallFontListenerInstalled = true;
  }
  if (cachedSmallFontChoice === null) {
    const raw = getStringSetting(UI_FONT_SETTING_KEY, "terminus");
    cachedSmallFontChoice = (UI_FONT_VALUES as readonly string[]).includes(raw)
      ? (raw as UiFontChoice)
      : "terminus";
  }
  return SMALL_FONT_FOR_CHOICE[cachedSmallFontChoice];
}

export function getDefaultSmallFont(): BdfFont {
  return getFont(currentSmallFontName());
}
export function getDefaultMediumFont(): BdfFont {
  return getFont("terminus16");
}
export function getDefaultLargeFont(): BdfFont {
  return getFont("terminus24");
}
