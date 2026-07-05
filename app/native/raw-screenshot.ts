import { Utils } from "@nativescript/core";

import { type GrayImage } from "../graphics/image";

declare const com: any;

/**
 * Save an image as the raw headerless 576x288 4bpp frame buffer (the exact
 * bytes the wire compressor sees) for compression experiments. Returns the
 * absolute path of the written file; retrieve with
 *   adb pull /sdcard/Android/data/com.faceclaw.app/files/screenshots/
 */
export function saveRawScreenshot(image: GrayImage): string {
  const context = Utils.android.getApplicationContext();
  if (!context) throw new Error("Android application context unavailable");
  return String(
    com.faceclaw.app.ScreenshotUtil.saveRawScreenshot(
      context,
      image.pixels.buffer,
      image.width,
      image.height,
    ),
  );
}
