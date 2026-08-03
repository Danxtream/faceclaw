import { launchWorkerAppWindow, type AppDefinition } from "../app-definition";

const roamApp: AppDefinition = {
  appId: "roam",
  title: "Roam",
  icon: "roam",
  launch: (ctx) =>
    launchWorkerAppWindow(ctx, {
      createWorker: () => new Worker("./roam-app.worker"),
      windowId: "roam:main",
      title: "Roam",
      iconLetter: "R",
      icon: "roam",
    }),
};

export default roamApp;
