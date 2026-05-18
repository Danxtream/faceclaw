import { Application, isAndroid } from "@nativescript/core";

const MAX_SHARED_TEXT_CHARS = 200_000;

export function registerShareIntentHandler(): void {
  if (!isAndroid) {
    return;
  }

  Application.on(Application.launchEvent, (args) => {
    const intent = (args as { android?: android.content.Intent }).android;
    if (intent) {
      void handleShareIntent(intent);
    }
  });

  Application.android.on(Application.android.activityNewIntentEvent, (args) => {
    const intent = (args as { intent?: android.content.Intent }).intent;
    if (intent) {
      Application.android.foregroundActivity?.setIntent(intent);
      void handleShareIntent(intent);
    }
  });
}

async function handleShareIntent(intent: android.content.Intent): Promise<void> {
  const text = readPlainTextShare(intent);
  if (text === null) {
    return;
  }
  const { dashboardController } = await import("../g2/dashboard-controller");
  await dashboardController.openTelepromptDocument(text);
}

function readPlainTextShare(intent: android.content.Intent): string | null {
  if (intent.getAction() !== android.content.Intent.ACTION_SEND) {
    return null;
  }

  const mimeType = intent.getType();
  if (mimeType !== null && !mimeType.toLowerCase().startsWith("text/")) {
    return null;
  }

  const directText = intent.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT);
  if (directText !== null) {
    return limitSharedText(String(directText));
  }

  const stream = intent.getParcelableExtra(android.content.Intent.EXTRA_STREAM) as android.net.Uri | null;
  if (stream === null) {
    return null;
  }

  return readTextUri(stream);
}

function readTextUri(uri: android.net.Uri): string | null {
  const activity = Application.android.foregroundActivity ?? Application.android.startActivity;
  const resolver = activity?.getContentResolver();
  if (!resolver) {
    return null;
  }

  const inputStream = resolver.openInputStream(uri);
  if (inputStream === null) {
    return null;
  }

  const reader = new java.io.BufferedReader(
    new java.io.InputStreamReader(inputStream, java.nio.charset.Charset.forName("UTF-8")),
  );
  try {
    const lines: string[] = [];
    let totalLength = 0;
    let line: string | null;
    while ((line = reader.readLine()) !== null) {
      const next = lines.length === 0 ? line : `\n${line}`;
      if (totalLength + next.length > MAX_SHARED_TEXT_CHARS) {
        lines.push(next.slice(0, MAX_SHARED_TEXT_CHARS - totalLength));
        break;
      }
      lines.push(next);
      totalLength += next.length;
    }
    return lines.join("");
  } finally {
    reader.close();
  }
}

function limitSharedText(text: string): string {
  return text.length <= MAX_SHARED_TEXT_CHARS ? text : text.slice(0, MAX_SHARED_TEXT_CHARS);
}
