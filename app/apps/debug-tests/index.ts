import { type AppDefinition } from "../app-definition";
import { createDebugTestsAppWindow, DEBUG_TESTS_SURFACE_ID, DEBUG_TESTS_WINDOW_ID } from "./debug-tests-app";

const debugTestsApp: AppDefinition = {
  appId: "debug-tests",
  title: "Debug tests",
  icon: "flask-conical",
  launch: (ctx) => ctx.launchInProcessApp(DEBUG_TESTS_WINDOW_ID, DEBUG_TESTS_SURFACE_ID, createDebugTestsAppWindow),
};

export default debugTestsApp;
