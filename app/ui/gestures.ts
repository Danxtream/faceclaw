/**
 * Compact glyphs for the ring gestures, used in on-glasses hint text instead
 * of spelling the gesture out. All codepoints exist in terminus12/16.
 *
 *   click        · (U+00B7 middle dot)
 *   double-click ·· (twice)
 *   scroll       ▲▼ (U+25B2 / U+25BC)
 *   long-press   - (hyphen-minus)
 */
export const GESTURE_CLICK = "·";
export const GESTURE_DOUBLE_CLICK = "··";
export const GESTURE_SCROLL_UP = "▲";
export const GESTURE_SCROLL_DOWN = "▼";
export const GESTURE_SCROLL = "▲▼";
export const GESTURE_LONG_PRESS = "-";

/**
 * Join "glyph action" hint pairs into a single line, e.g.
 *   gestureHints([[GESTURE_CLICK, "save"], [GESTURE_DOUBLE_CLICK, "back"]])
 *   => "· save   ·· back"
 */
export function gestureHints(pairs: Array<[string, string]>): string {
  return pairs.map(([glyph, action]) => `${glyph} ${action}`).join("   ");
}
