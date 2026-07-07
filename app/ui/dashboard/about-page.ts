import { getDefaultSmallFont } from "~/graphics/bdffont";
import { GrayImage } from "~/graphics/image";
import { getDashboardLogo } from "~/graphics/logo";
import { DashboardInputEvent, Layer, LayerContext, LayerStack } from "../layers";

export class AboutPage implements Layer {
  paint(ctx: LayerContext): GrayImage {
    // Sized to the hosting stack (the Settings app viewport).
    const { width, height } = ctx.stack.getBaseSize();
    const image = new GrayImage(width, height, 0);
    const logo = getDashboardLogo();
    const dashboardFont = getDefaultSmallFont();
    image.drawText(dashboardFont, 22, 16, "About Faceclaw", 220);
    if (logo) {
      image.bitBlt(logo, 22, 42, { transparentZero: true });
    }
    image.drawText(dashboardFont, 108, 48, "Faceclaw", 220);
    image.drawText(dashboardFont, 108, 64, "Dashboard prototype", 180);

    image.drawTextWrapped({
      font: dashboardFont,
      x: 22, y: 128,
      width: width - 44,
      text: "By James Babcock. Distributed under the GNU General Public License, version 3. Version 0.1.0. Too much of an early janky development prototype to have proper numbered releases.",
      value: 180
    });
    return image;
  }

  handleInput(event: DashboardInputEvent, ctx: { stack: LayerStack }): void {
    if (event.type === "double-click") {
      ctx.stack.pop();
    }
  }
}
