import { GrayImage } from "./image";

declare const com: any;
declare const global: any;

/**
 * Vector icons for window indicators (and anywhere else). SVGs are rendered
 * once to a correctly sized grayscale bitmap by the Java IconRenderer (a
 * small SVG subset: path/circle/rect/line/polyline) and cached here. To add
 * an icon, drop its SVG source into ICON_SVGS — Lucide icons
 * (https://lucide.dev, stroked, 24px viewBox) work as-is; simple single-color
 * Noun Project glyphs also work.
 */

// Stroke width in viewBox units (Lucide's default is 2).
const ICON_STROKE_WIDTH = 2;

// Lucide icons (MIT/ISC licensed). Kept verbatim so they can be diffed
// against upstream if an icon needs updating.
export const ICON_SVGS = {
  "layout-grid":
    '<svg viewBox="0 0 24 24"><rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/></svg>',
  timer:
    '<svg viewBox="0 0 24 24"><line x1="10" x2="14" y1="2" y2="2"/><line x1="12" x2="15" y1="14" y2="11"/><circle cx="12" cy="14" r="8"/></svg>',
  terminal:
    '<svg viewBox="0 0 24 24"><path d="m7 11 2-2-2-2"/><path d="M11 13h4"/><rect width="18" height="18" x="3" y="3" rx="2" ry="2"/></svg>',
  "file-text":
    '<svg viewBox="0 0 24 24"><path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/></svg>',
  music:
    '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  activity:
    '<svg viewBox="0 0 24 24"><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></svg>',
  bell:
    '<svg viewBox="0 0 24 24"><path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/></svg>',
  "flask-conical":
    '<svg viewBox="0 0 24 24"><path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/></svg>',
  settings:
    '<svg viewBox="0 0 24 24"><path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/></svg>',
  mic:
    '<svg viewBox="0 0 24 24"><path d="M12 19v3"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><rect x="9" y="2" width="6" height="13" rx="3"/></svg>',
} as const;

export type IconName = keyof typeof ICON_SVGS;

const cache = new Map<string, GrayImage | null>();

/** Render an icon SVG to a size×size grayscale bitmap, rendered once and cached. */
export function renderIcon(name: IconName, size: number): GrayImage | null {
  const key = `${name}:${size}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;

  let icon: GrayImage | null = null;
  if (global.isAndroid) {
    try {
      const bytes = com.faceclaw.app.IconRenderer.renderSvgGray(ICON_SVGS[name], Math.round(size), ICON_STROKE_WIDTH);
      if (bytes && bytes.length >= size * size) {
        icon = new GrayImage(size, size, 0);
        for (let i = 0; i < size * size; i++) {
          icon.pixels[i] = bytes[i] & 0xff;
        }
      }
    } catch (error) {
      console.warn(`renderIcon(${name}) failed: ${error}`);
    }
  }
  cache.set(key, icon);
  return icon;
}
