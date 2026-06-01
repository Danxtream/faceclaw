import { GrayImage } from "./image";
import { loadPngAsGrayImage } from "./imagefile";

let cachedDashboardLogo: GrayImage | null | undefined;

export function getDashboardLogo(): GrayImage | null {
  if (cachedDashboardLogo !== undefined) {
    return cachedDashboardLogo;
  }
  try {
    cachedDashboardLogo = loadPngAsGrayImage("images/faceclaw-logo-dashboard.png");
  } catch {
    cachedDashboardLogo = null;
  }
  return cachedDashboardLogo;
}
