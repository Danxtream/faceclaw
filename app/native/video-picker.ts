import { Application, isAndroid } from "@nativescript/core";

export type PickedVideo = {
  name: string;
  uri: string;
  mimeType: string;
};

const VIDEO_PICK_REQUEST = 0x5644;

let pending:
  | {
      resolve: (value: PickedVideo | null) => void;
      reject: (error: Error) => void;
    }
  | null = null;

let handlerRegistered = false;

export function openVideoPicker(): Promise<PickedVideo | null> {
  if (!isAndroid) {
    return Promise.reject(new Error("Video picker is Android only"));
  }

  if (pending) {
    return Promise.reject(new Error("Video picker already open"));
  }

  registerActivityResultHandler();

  const activity =
    Application.android.foregroundActivity ??
    Application.android.startActivity;

  if (!activity) {
    return Promise.reject(new Error("No foreground Android activity"));
  }

  return new Promise<PickedVideo | null>((resolve, reject) => {
    pending = { resolve, reject };

    try {
      const intent = new android.content.Intent(
        android.content.Intent.ACTION_OPEN_DOCUMENT,
      );

      intent.addCategory(android.content.Intent.CATEGORY_OPENABLE);

      // Raw Annex-B H.264 streams are often reported by Android providers as
      // application/octet-stream, so allow any MIME type here and validate
      // the selected filename ourselves.
      intent.setType("*/*");

      activity.startActivityForResult(intent, VIDEO_PICK_REQUEST);
    } catch (error) {
      pending = null;
      reject(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function registerActivityResultHandler(): void {
  if (handlerRegistered) return;
  handlerRegistered = true;

  Application.android.on(
    Application.android.activityResultEvent,
    (args: {
      requestCode: number;
      resultCode: number;
      intent?: android.content.Intent;
    }) => {
      if (args.requestCode !== VIDEO_PICK_REQUEST || !pending) {
        return;
      }

      const current = pending;
      pending = null;

      if (args.resultCode !== android.app.Activity.RESULT_OK || !args.intent) {
        current.resolve(null);
        return;
      }

      try {
        const uri = args.intent.getData() as android.net.Uri | null;
        if (!uri) {
          current.resolve(null);
          return;
        }

        const activity =
          Application.android.foregroundActivity ??
          Application.android.startActivity;

        const resolver = activity?.getContentResolver();
        if (!resolver) {
          throw new Error("Android content resolver unavailable");
        }

        const name = queryDisplayName(resolver, uri);
        const mimeType = String(resolver.getType(uri) ?? "");

        if (!isSupportedH264Name(name)) {
          throw new Error(
            `Unsupported file "${name}". Select a raw .h264 or .264 stream.`,
          );
        }

        current.resolve({
          name,
          uri: String(uri.toString()),
          mimeType,
        });
      } catch (error) {
        current.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }
    },
  );
}

function queryDisplayName(
  resolver: android.content.ContentResolver,
  uri: android.net.Uri,
): string {
  const projection = [
    android.provider.OpenableColumns.DISPLAY_NAME,
  ];

  const cursor = resolver.query(uri, projection, null, null, null);

  if (cursor !== null) {
    try {
      if (cursor.moveToFirst()) {
        const index = cursor.getColumnIndex(
          android.provider.OpenableColumns.DISPLAY_NAME,
        );

        if (index >= 0) {
          const value = cursor.getString(index);
          if (value !== null) {
            return String(value);
          }
        }
      }
    } finally {
      cursor.close();
    }
  }

  return String(uri.getLastPathSegment() ?? "video.h264");
}

function isSupportedH264Name(name: string): boolean {
  return /\.(h264|264)$/i.test(name);
}
