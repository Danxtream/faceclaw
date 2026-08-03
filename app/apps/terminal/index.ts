import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const terminalApp: AppDefinition = {
  appId: "terminal",
  title: "Terminal",
  icon: "terminal",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./terminal-app.worker"),
      windowId: "terminal:hub",
      title: "Terminal",
      iconLetter: "T",
      icon: "terminal",
      // Session windows stay independent: launching reopens the hub even
      // while terminal sessions are open.
      matchExistingBy: "windowId",
    }),
};

export default terminalApp;
