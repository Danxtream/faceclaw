import { Application, isAndroid } from "@nativescript/core";

export function readH264File(uriText: string): Uint8Array {
  console.log(`[H264FILE] enter uri=${uriText}`);

  if (!isAndroid) {
    throw new Error("H.264 file reading is Android only");
  }

  const activity =
    Application.android.foregroundActivity ??
    Application.android.startActivity;

  console.log(`[H264FILE] activity=${activity ? "yes" : "no"}`);

  const resolver = activity?.getContentResolver();
  if (!resolver) {
    throw new Error("Android content resolver unavailable");
  }

  console.log("[H264FILE] resolver ready");

  const uri = android.net.Uri.parse(uriText);
  console.log(`[H264FILE] parsed uri=${uri}`);

  const inputStream = resolver.openInputStream(uri);

  if (inputStream === null) {
    throw new Error("Unable to open selected H.264 file");
  }

  console.log("[H264FILE] stream opened");

  const output = new java.io.ByteArrayOutputStream();

  try {
    const buffer = Array.create("byte", 64 * 1024);
    console.log(`[H264FILE] buffer created length=${buffer.length}`);

    let total = 0;

    while (true) {
      const count = inputStream.read(buffer);

      if (count < 0) break;
      if (count === 0) continue;

      output.write(buffer, 0, count);
      total += count;

      console.log(`[H264FILE] read total=${total}`);
    }

    console.log(`[H264FILE] EOF total=${total}`);

    const bytes = output.toByteArray();
    console.log(`[H264FILE] java bytes length=${bytes.length}`);

    const result = new Uint8Array(bytes.length);

    for (let i = 0; i < bytes.length; i++) {
      result[i] = bytes[i] & 0xff;
    }

    console.log(`[H264FILE] converted length=${result.length}`);

    return result;
  } catch (error) {
    console.log(`[H264FILE] ERROR ${error}`);
    throw error;
  } finally {
    console.log("[H264FILE] closing");
    inputStream.close();
    output.close();
  }
}
