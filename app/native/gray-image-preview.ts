import { ImageSource } from "@nativescript/core";

import { type GrayImage } from "../graphics/image";

declare const com: any;

const PREVIEW_BRIGHTEN_GAMMA = 0.7;

/**
 * Build the phone-UI preview for a frame. The pixel buffer is passed to Java
 * as an ArrayBuffer (marshalled to a ByteBuffer) and expanded to ARGB there;
 * doing the per-pixel work in JS or copying element-by-element across the
 * bridge costs ~150ms per frame.
 */
export function grayImageToPreviewSource(image: GrayImage): ImageSource | null {
  if (!global.isAndroid) {
    return null;
  }

  const bitmap = com.faceclaw.app.PreviewBitmapUtil.fromGray(
    image.pixels.buffer,
    image.width,
    image.height,
    PREVIEW_BRIGHTEN_GAMMA,
  );
  return new ImageSource(bitmap);
}
