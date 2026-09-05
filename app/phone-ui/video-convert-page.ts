import { EventData, Page } from "@nativescript/core";
import { VideoConvertViewModel } from "./video-convert-view-model";

export function navigatingTo(args: EventData): void {
  const page = args.object as Page;
  page.bindingContext = new VideoConvertViewModel();
}

export function loaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as VideoConvertViewModel | null)?.onResume();
}

export function unloaded(args: EventData): void {
  const page = args.object as Page;
  (page.bindingContext as VideoConvertViewModel | null)?.onPause();
}

export function onFileTap(args: EventData & { index?: number }): void {
  const page = (args.object as any)?.page as Page | undefined;
  const model = page?.bindingContext as VideoConvertViewModel | undefined;
  const index = Number(args.index);
  if (!model || !Number.isInteger(index) || index < 0) return;
  void model.onFileTap(index);
}
