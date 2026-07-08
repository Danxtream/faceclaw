/**
 * Filesystem access for the on-glasses file browser. Arbitrary files outside
 * app-specific directories require the "All files access" special permission
 * on modern Android (MANAGE_EXTERNAL_STORAGE, granted via a Settings page,
 * reasonable for a sideloaded personal tool).
 */
import { Utils } from "@nativescript/core";

declare const android: any;
declare const java: any;
declare const global: any;

const MAX_TEXT_FILE_BYTES = 2_000_000;
const MAX_TEXT_CHARS = 500_000;

export type DirectoryEntry = {
  name: string;
  path: string;
  isDirectory: boolean;
  sizeBytes: number;
};

export function hasAllFilesAccess(): boolean {
  if (!global.isAndroid) return false;
  try {
    return Boolean(android.os.Environment.isExternalStorageManager());
  } catch {
    // Pre-R devices have no such concept; the legacy permission suffices.
    return true;
  }
}

/** Open the system Settings page where the user grants All files access. */
export function requestAllFilesAccess(): void {
  const context = Utils.android.getApplicationContext();
  const intent = new android.content.Intent(
    android.provider.Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION,
    android.net.Uri.parse(`package:${context.getPackageName()}`),
  );
  intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
  context.startActivity(intent);
}

export function externalStorageRootPath(): string {
  return String(android.os.Environment.getExternalStorageDirectory().getAbsolutePath());
}

/** List a directory, directories first then by name; null when unreadable. */
export function listDirectory(path: string): DirectoryEntry[] | null {
  try {
    const dir = new java.io.File(path);
    if (!dir.isDirectory()) return null;
    const files = dir.listFiles();
    if (files === null) return null;
    const entries: DirectoryEntry[] = [];
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      entries.push({
        name: String(file.getName()),
        path: String(file.getAbsolutePath()),
        isDirectory: Boolean(file.isDirectory()),
        sizeBytes: Number(file.length()),
      });
    }
    entries.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
      return a.name.toLowerCase() < b.name.toLowerCase() ? -1 : 1;
    });
    return entries;
  } catch (error) {
    console.warn(`listDirectory failed for ${path}: ${error}`);
    return null;
  }
}

/** Write UTF-8 text to a file in the public Downloads directory; returns its path or null. */
export function writeTextToDownloads(filename: string, text: string): string | null {
  try {
    const downloads = android.os.Environment.getExternalStoragePublicDirectory(
      android.os.Environment.DIRECTORY_DOWNLOADS,
    );
    downloads.mkdirs();
    const file = new java.io.File(downloads, filename);
    const bytes = new java.lang.String(text).getBytes("UTF-8");
    // FileOutputStream rather than Files.write to avoid NativeScript varargs /
    // overload resolution pitfalls.
    const stream = new java.io.FileOutputStream(file);
    try {
      stream.write(bytes);
    } finally {
      stream.close();
    }
    return String(file.getAbsolutePath());
  } catch (error) {
    console.warn(`writeTextToDownloads failed for ${filename}: ${error}`);
    return null;
  }
}

/** Read a UTF-8 text file (size-capped); null when unreadable or too large. */
export function readTextFile(path: string): string | null {
  try {
    const file = new java.io.File(path);
    if (!file.isFile() || file.length() > MAX_TEXT_FILE_BYTES) return null;
    // File.toPath() rather than Paths.get(path): NativeScript resolves the
    // single-string Paths.get call to the (java.net.URI) overload, which
    // aborts in JNI.
    const bytes = java.nio.file.Files.readAllBytes(file.toPath());
    const text = String(new java.lang.String(bytes, "UTF-8"));
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  } catch (error) {
    console.warn(`readTextFile failed for ${path}: ${error}`);
    return null;
  }
}
