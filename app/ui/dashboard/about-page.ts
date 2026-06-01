import { getDefaultSmallFont } from "~/graphics/bdffont";
import { G2_LENS_HEIGHT, G2_LENS_WIDTH, GrayImage } from "~/graphics/image";
import { getDashboardLogo } from "~/graphics/logo";
import { DashboardInputEvent, Layer, LayerStack } from "../layers";

export class AboutPage implements Layer {
  paint(): GrayImage {
    const image = new GrayImage(G2_LENS_WIDTH, G2_LENS_HEIGHT, 0);
    const logo = getDashboardLogo();
    const dashboardFont = getDefaultSmallFont();
    image.drawText(dashboardFont, 22, 16, "About Faceclaw", 220);
    if (logo) {
      image.bitBlt(logo, 22, 42);
    }
    image.drawText(dashboardFont, 108, 48, "Faceclaw", 220);
    image.drawText(dashboardFont, 108, 64, "Dashboard prototype", 180);

    image.drawTextWrapped({
      font: dashboardFont,
      x: 22, y: 128,
      width: G2_LENS_WIDTH - 44,
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
