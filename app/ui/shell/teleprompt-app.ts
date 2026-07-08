import { externalStorageRootPath, readTextFile, type DirectoryEntry } from "../../native/file-access";
import { FileBrowserLayer } from "../apps/file-browser";
import { TelepromptLayer } from "../apps/teleprompt";
import { MenuLayer } from "../menu";
import { APP_VIEWPORT } from "./geometry";
import {
  createInProcessWindow,
  YieldAtRootLayer,
  type InProcessAppOptions,
  type InProcessWindow,
} from "./in-process-window";
import { shell } from "./shell";

export const TELEPROMPT_WINDOW_ID = "teleprompt";
export const TELEPROMPT_SURFACE_ID = "window:teleprompt";

const SUPPORTED_FILE = /\.(txt|md|log)$/i;

export type TelepromptBrowserOptions = InProcessAppOptions & {
  /** Open a document as its own shell window (also used by the share intent). */
  openDocumentWindow: (title: string, text: string) => void;
};

/**
 * The Teleprompt app's launcher-opened window: a file browser over external
 * storage. Picking a supported (text) file offers viewing it in this window
 * or opening it as a new window.
 */
export function createTelepromptBrowserWindow(options: TelepromptBrowserOptions): InProcessWindow {
  const browser = new FileBrowserLayer({
    startPath: externalStorageRootPath(),
    isSupportedFile: (name) => SUPPORTED_FILE.test(name),
    // The browser handles double-click itself (up a directory), so it is not
    // wrapped in YieldAtRootLayer; it yields explicitly from the top level.
    onLeave: () => shell.yieldFocusToSidebar(),
    onFilePicked: (entry, ctx) => {
      ctx.stack.push(createFilePickedMenu(entry, options.openDocumentWindow));
    },
  });
  return createInProcessWindow({
    appId: "teleprompt",
    windowId: TELEPROMPT_WINDOW_ID,
    title: "Teleprompt",
    iconLetter: "Tp",
    icon: "file-text",
    closeable: true,
    actions: options.actions,
    baseLayer: browser,
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

/** One opened document as its own window (from the browser or a share intent). */
export function createTelepromptDocumentWindow(
  windowId: string,
  title: string,
  text: string,
  options: InProcessAppOptions,
): InProcessWindow {
  return createInProcessWindow({
    appId: "teleprompt",
    windowId,
    title,
    iconLetter: "Tp",
    icon: "file-text",
    closeable: true,
    actions: options.actions,
    baseLayer: new YieldAtRootLayer(new TelepromptLayer(text, title)),
    submitFrame: options.submitFrame,
    setSurfaceVisible: options.setSurfaceVisible,
    removeSurface: options.removeSurface,
    onClosed: options.onClosed,
  });
}

function createFilePickedMenu(
  entry: DirectoryEntry,
  openDocumentWindow: (title: string, text: string) => void,
): MenuLayer {
  return new MenuLayer(
    entry.name,
    [
      {
        label: "View here",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          ctx.stack.push(new TelepromptLayer(text ?? "(could not read file)", entry.name));
        },
      },
      {
        label: "Open in new window",
        onSelect: (ctx) => {
          const text = readTextFile(entry.path);
          ctx.stack.pop();
          openDocumentWindow(entry.name, text ?? "(could not read file)");
        },
      },
    ],
    {
      x: 8,
      y: 8,
      width: 272,
      minHeight: 0,
      maxHeight: APP_VIEWPORT.height - 16,
    },
  );
}
