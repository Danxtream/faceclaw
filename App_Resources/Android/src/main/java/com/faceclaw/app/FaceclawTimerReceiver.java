package com.faceclaw.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** Receives durable timer alarms even if the NativeScript worker is asleep. */
public class FaceclawTimerReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !FaceclawTimerNotifications.ACTION_EXPIRE.equals(intent.getAction())) {
            return;
        }
        long timerId = intent.getLongExtra(FaceclawTimerNotifications.EXTRA_TIMER_ID, 0);
        if (timerId == 0) {
            return;
        }
        String durationLabel = intent.getStringExtra(FaceclawTimerNotifications.EXTRA_DURATION_LABEL);
        FaceclawTimerNotifications.showExpiredOnce(context, timerId, durationLabel);
    }
}
