import { Application, isAndroid } from "@nativescript/core";

declare const android: any;
declare const java: any;

function readStream(inputStream: any): Uint8Array {
  const output = new java.io.ByteArrayOutputStream();
  try {
    const buffer = Array.create("byte", 64 * 1024);
    while (true) {
      const count = inputStream.read(buffer);
      if (count < 0) break;
      if (count === 0) continue;
      output.write(buffer, 0, count);
    }
    const bytes = output.toByteArray();
    const result = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) result[i] = bytes[i] & 0xff;
    return result;
  } finally {
    inputStream.close();
    output.close();
  }
}

export function readH264File(uriText: string): Uint8Array {
  if (!isAndroid) throw new Error("H.264 file reading is Android only");

  // The on-glasses G2 file browser returns ordinary absolute filesystem paths.
  if (uriText.startsWith("/")) {
    const file = new java.io.File(uriText);
    if (!file.isFile()) throw new Error(`H.264 file does not exist: ${uriText}`);
    return readStream(new java.io.FileInputStream(file));
  }

  const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
  const resolver = activity?.getContentResolver();
  if (!resolver) throw new Error("Android content resolver unavailable");
  const uri = android.net.Uri.parse(uriText);
  const inputStream = resolver.openInputStream(uri);
  if (inputStream === null) throw new Error("Unable to open selected H.264 file");
  return readStream(inputStream);
}
