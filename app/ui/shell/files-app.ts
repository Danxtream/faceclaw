import { readTextFile, type DirectoryEntry } from "../../native/file-access";
import { isDecodableImageFile } from "../../native/image-files";
import { FileBrowserLayer } from "../apps/file-browser";
import { FileInfoDialogLayer, type FileInfoAction } from "../apps/file-info-dialog";
import { ImageViewerLayer } from "../apps/image-viewer";
import { TextViewerLayer } from "../apps/text-viewer";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";
import { shell } from "./shell";

export const FILES_WINDOW_ID = "files";
export const FILES_SURFACE_ID = "window:files";

const TEXT_FILE = /\.(txt|md|log)$/i;

export type FilesAppOptions = InProcessAppOptions & {
  /** Open a text document as its own shell window (also used by the share intent). */
  openDocumentWindow: (title: string, text: string) => void;
  /** Open an image file as its own shell window. */
  openImageWindow: (title: string, path: string) => void;
};

/**
 * The Files app's launcher-opened window: a file browser over Places
 * (bookmarks and storage roots). Picking any file opens an info dialog with
 * metadata plus, for viewable types (text, images), the open actions.
 */
export function createFilesAppWindow(options: FilesAppOptions): InProcessWindow {
  let created: InProcessWindow | null = null;
  const browser = new FileBrowserLayer({
    isSupportedFile: (name) => TEXT_FILE.test(name) || isDecodableImageFile(name),
    // The browser handles double-click itself (up a level), so it is not
    // wrapped in YieldAtRootLayer; it yields explicitly from the top level.
    onLeave: () => shell.yieldFocusToSidebar(),
    onFilePicked: (entry, ctx) => {
      ctx.stack.push(new FileInfoDialogLayer(entry, fileOpenActions(entry, options)));
    },
  });
  created = createInProcessWindow({
    appId: "files",
    windowId: FILES_WINDOW_ID,
    title: "Files",
    iconLetter: "F",
    icon: "folder",
    closeable: true,
    // Browser actions (view switch, bookmarks) only apply while the browser
    // itself is on top; a pushed viewer or dialog gets just the defaults.
    menuItems: () => (created && !created.stack.isAtBase() ? [] : browser.buildMenuItems()),
    actions: options.actions,
    baseLayer: browser,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
  return created;
}

/** One opened text document as its own window (from the browser or a share intent). */
export function createTextDocumentWindow(
  windowId: string,
  title: string,
  text: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "F",
    icon: "file-text",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new TextViewerLayer(text, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/** One opened image file as its own window. */
export function createImageDocumentWindow(
  windowId: string,
  title: string,
  path: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "files",
    windowId,
    title,
    iconLetter: "F",
    icon: "image",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new ImageViewerLayer(path, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/**
 * The open actions for the picked-file dialog: View here / Open in new
 * window for viewable types, empty for everything else (metadata only).
 */
function fileOpenActions(entry: DirectoryEntry, options: FilesAppOptions): FileInfoAction[] {
  if (TEXT_FILE.test(entry.name)) {
    return [
      {
        label: "View here",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          ctx.stack.push(new TextViewerLayer(text ?? "(could not read file)", entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          options.openDocumentWindow(entry.name, text ?? "(could not read file)");
        },
      },
    ];
  }
  if (isDecodableImageFile(entry.name)) {
    return [
      {
        label: "View here",
        onSelect: (ctx) => {
          ctx.stack.pop();
          ctx.stack.push(new ImageViewerLayer(entry.path, entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          ctx.stack.pop();
          options.openImageWindow(entry.name, entry.path);
        },
      },
    ];
  }
  return [];
}
