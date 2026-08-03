import { type AppDefinition } from "../app-definition";
import { createMusicAppWindow, MUSIC_SURFACE_ID, MUSIC_WINDOW_ID } from "./music-app";

const musicApp: AppDefinition = {
  appId: "music",
  title: "Music",
  icon: "music",
  launch: (ctx) => ctx.launchInProcessApp(MUSIC_WINDOW_ID, MUSIC_SURFACE_ID, createMusicAppWindow),
};

export default musicApp;
