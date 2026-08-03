import { type AppContext, type AppDefinition } from "../app-definition";
import {
  createFilesAppWindow,
  createImageDocumentWindow,
  createTextDocumentWindow,
  FILES_SURFACE_ID,
  FILES_WINDOW_ID,
} from "./files-app";

// Document windows are closeable and non-singleton; the serial keeps their
// windowIds unique.
let nextDocumentSerial = 1;

function openTextDocumentWindow(ctx: AppContext, title: string, text: string): void {
  const windowId = `files:doc:${nextDocumentSerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createTextDocumentWindow(windowId, title, text, options),
    )
    .catch((error) => {
      ctx.appendLog(`text document window failed: ${error}`);
    });
}

function openImageDocumentWindow(ctx: AppContext, title: string, path: string): void {
  const windowId = `files:doc:${nextDocumentSerial++}`;
  void ctx
    .launchInProcessApp(windowId, `window:${windowId}`, (options) =>
      createImageDocumentWindow(windowId, title, path, options),
    )
    .catch((error) => {
      ctx.appendLog(`image window failed: ${error}`);
    });
}

const filesApp: AppDefinition = {
  appId: "files",
  title: "Files",
  icon: "folder",
  launch: (ctx) =>
    ctx.launchInProcessApp(FILES_WINDOW_ID, FILES_SURFACE_ID, (options) =>
      createFilesAppWindow({
        ...options,
        openDocumentWindow: (title, text) => openTextDocumentWindow(ctx, title, text),
        openImageWindow: (title, path) => openImageDocumentWindow(ctx, title, path),
      }),
    ),
  // A document arriving via Android's Share intent opens as its own window.
  openSharedText: (ctx, title, text) => openTextDocumentWindow(ctx, title, text),
};

export default filesApp;
