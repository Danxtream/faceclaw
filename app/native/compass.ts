declare const com: any;
declare const global: any;

export const COMPASS_CHANGED = 15;
export const COMPASS_CALIBRATION_STARTED = 16;
export const COMPASS_CALIBRATION_COMPLETE = 17;

export type CompassEvent = {
  command: number;
  /** Magnetic heading in degrees, or -1 for calibration-only events. */
  headingDegrees: number;
};

function activeCommunicator(): any {
  if (!global.isAndroid) return null;
  try {
    return com.faceclaw.app.FaceclawBleCommunicator.getActive();
  } catch {
    return null;
  }
}

/** Request CFW mode 10 to start/stop the stock firmware compass. */
export function setCompassEnabled(enabled: boolean): void {
  try {
    activeCommunicator()?.setCompassEnabled(enabled);
  } catch (error) {
    console.warn(`setCompassEnabled failed: ${error}`);
  }
}

/** Subscribe to stock compass heading/calibration notifications. */
export function addCompassListener(listener: (event: CompassEvent) => void): () => void {
  const active = activeCommunicator();
  if (!active) return () => {};
  const proxy = new com.faceclaw.app.FaceclawCompassListener({
    onCompassEvent: (command: number, headingDegrees: number) => {
      listener({ command: Number(command), headingDegrees: Number(headingDegrees) });
    },
  });
  active.addCompassListener(proxy);
  return () => {
    try {
      activeCommunicator()?.removeCompassListener(proxy);
    } catch {
      // The communicator may have been replaced during a disconnect.
    }
  };
}
