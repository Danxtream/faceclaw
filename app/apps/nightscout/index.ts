import { type AppDefinition } from "../app-definition";
import { createNightscoutAppWindow, NIGHTSCOUT_SURFACE_ID, NIGHTSCOUT_WINDOW_ID } from "./nightscout-app";

const nightscoutApp: AppDefinition = {
  appId: "nightscout",
  title: "Nightscout",
  icon: "nightscout",
  launch: (ctx) => ctx.launchInProcessApp(NIGHTSCOUT_WINDOW_ID, NIGHTSCOUT_SURFACE_ID, createNightscoutAppWindow),
};

export default nightscoutApp;
