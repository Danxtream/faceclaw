/**
 * Image-file decoding for the on-glasses image viewer, backed by the Java
 * ImageFileLoader (BitmapFactory handles PNG/JPEG/GIF/BMP/WebP/HEIC).
 */
import { GrayImage } from "../graphics/image";
import { toUint8Array } from "../util/array-util";

declare const com: any;
declare const global: any;

/** File extensions BitmapFactory can decode (no SVG). */
const DECODABLE_IMAGE = /\.(png|jpe?g|gif|bmp|webp|heic|heif)$/i;

export function isDecodableImageFile(name: string): boolean {
  return DECODABLE_IMAGE.test(name);
}

/**
 * Decode a gray packet ([widthLo, widthHi, heightLo, heightHi, pixels...],
 * the format the Java helpers return) into a GrayImage; null when empty or
 * malformed.
 */
export function grayImageFromPacket(raw: ArrayLike<number> | null | undefined): GrayImage | null {
  const bytes = toUint8Array(raw);
  if (bytes.length < 4) return null;
  const width = bytes[0]! | (bytes[1]! << 8);
  const height = bytes[2]! | (bytes[3]! << 8);
  if (width <= 0 || height <= 0 || bytes.length < 4 + width * height) return null;
  const image = new GrayImage(width, height, 0);
  image.pixels.set(bytes.subarray(4, 4 + width * height));
  return image;
}

/**
 * Load an image file as grayscale, downscaled to fit maxWidth x maxHeight
 * (aspect preserved, never upscaled); null when unreadable or undecodable.
 */
export function loadImageFileAsGray(path: string, maxWidth: number, maxHeight: number): GrayImage | null {
  if (!global.isAndroid) return null;
  try {
    return grayImageFromPacket(
      com.faceclaw.app.ImageFileLoader.loadGray(path, Math.round(maxWidth), Math.round(maxHeight)),
    );
  } catch (error) {
    console.warn(`loadImageFileAsGray failed for ${path}: ${error}`);
    return null;
  }
}
