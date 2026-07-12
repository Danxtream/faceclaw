package com.faceclaw.app;

import android.os.SystemClock;

final class InterruptibleSleep {
    private final Object lock = new Object();
    private boolean interrupted;

    boolean sleep(long ms) {
        long delayMs = Math.max(1, ms);
        long deadline = SystemClock.elapsedRealtime() + delayMs;
        synchronized (lock) {
            // Consume (do not clear-and-ignore) an interrupt delivered before this
            // sleep began. interrupt() runs on other threads with no lock held by
            // the sleeper between driveSession() returning and sleep() starting, so
            // clearing the flag at entry lost that wake and forced the worker to
            // sleep the full interval — up to 250ms per idle frame. Honoring it
            // costs at most one extra (cheap) driveSession pass.
            if (interrupted) {
                interrupted = false;
                return false;
            }
            while (true) {
                long remaining = deadline - SystemClock.elapsedRealtime();
                if (remaining <= 0) {
                    return true;
                }
                try {
                    lock.wait(remaining);
                } catch (InterruptedException ignored) {
                    interrupted = false;
                    return false;
                }
                if (interrupted) {
                    interrupted = false;
                    return false;
                }
            }
        }
    }

    void interrupt() {
        synchronized (lock) {
            interrupted = true;
            lock.notifyAll();
        }
    }
}
