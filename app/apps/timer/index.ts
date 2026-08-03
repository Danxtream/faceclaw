import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const timerApp: AppDefinition = {
  appId: "timer",
  title: "Timer",
  icon: "timer",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./timer-app.worker"),
      windowId: "timer:main",
      title: "Timer",
      iconLetter: "T",
      icon: "timer",
    }),
};

export default timerApp;
