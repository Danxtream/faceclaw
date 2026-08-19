import { getDefaultSmallFont } from "../../graphics/bdffont";
import { GrayImage } from "../../graphics/image";
import { truncateText } from "../../graphics/textwrap";
import { drawSelectionHighlight, scrollToKeepSelectionVisible } from "../../ui/menu";
import { DashboardInputEvent, Layer, LayerContext } from "../../ui/layers";
import type { AppDefinition } from "../app-definition";
import {
  getOrderedLauncherAppIds,
  isLauncherAppVisible,
  moveLauncherApp,
} from "./launcher-preferences";

const ROW_HEIGHT = 22;
const HEADER_HEIGHT = 24;
const FOOTER_HEIGHT = 18;

export class LauncherOrderLayer implements Layer {
  private selectedIndex = 0;
  private scrollRow = 0;
  private moving = false;

  constructor(private readonly apps: readonly AppDefinition[]) {}

  private orderedApps(): AppDefinition[] {
    const candidates = this.apps.filter(
      (app) => app.showInLauncher !== false && isLauncherAppVisible(app.appId),
    );
    const byId = new Map(candidates.map((app) => [app.appId, app]));
    return getOrderedLauncherAppIds(candidates.map((app) => app.appId))
      .map((id) => byId.get(id))
      .filter(Boolean) as AppDefinition[];
  }

  paint(ctx: LayerContext): GrayImage {
    const font = getDefaultSmallFont();
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const apps = this.orderedApps();
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, Math.max(0, apps.length - 1)));

    image.drawText(font, 16, 6, this.moving ? "Reorder apps - moving" : "Reorder apps", 220);
    const visibleRows = Math.max(1, Math.floor((height - HEADER_HEIGHT - FOOTER_HEIGHT) / ROW_HEIGHT));
    this.scrollRow = scrollToKeepSelectionVisible(
      this.scrollRow,
      this.selectedIndex,
      visibleRows,
      apps.length,
    );

    for (let i = this.scrollRow; i < Math.min(apps.length, this.scrollRow + visibleRows); i++) {
      const app = apps[i]!;
      const y = HEADER_HEIGHT + (i - this.scrollRow) * ROW_HEIGHT;
      if (i === this.selectedIndex) {
        drawSelectionHighlight(image, 10, y, width - 20, ROW_HEIGHT - 2, ctx.stack.isFocused(), 6);
      }
      const prefix = this.moving && i === this.selectedIndex ? "<> " : "";
      image.drawText(font, 18, y + 4, truncateText(font, `${prefix}${app.title}`, width - 36), 210);
    }

    image.drawText(
      font,
      14,
      height - 15,
      this.moving ? "scroll move   tap done   double back" : "scroll select   tap move   double back",
      110,
    );
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: LayerContext): void {
    const apps = this.orderedApps();
    if (!apps.length) {
      if (event.type === "double-click") ctx.stack.pop();
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, apps.length - 1));

    if (event.type === "double-click") {
      if (this.moving) this.moving = false;
      else ctx.stack.pop();
      return;
    }
    if (event.type === "click") {
      this.moving = !this.moving;
      return;
    }
    if (event.type !== "scroll-up" && event.type !== "scroll-down") return;

    const delta: -1 | 1 = event.type === "scroll-up" ? -1 : 1;
    if (!this.moving) {
      this.selectedIndex = Math.max(0, Math.min(apps.length - 1, this.selectedIndex + delta));
      return;
    }

    const appId = apps[this.selectedIndex]!.appId;
    const availableIds = apps.map((app) => app.appId);
    moveLauncherApp(appId, delta, availableIds);
    this.selectedIndex = Math.max(0, Math.min(apps.length - 1, this.selectedIndex + delta));
  }
}
