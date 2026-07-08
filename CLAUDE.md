This is Faceclaw, an Android program that provides user interface on the Even
Realities G2 smart glasses. It is written in a mix of Typescript/NativeScript
(for the user interface parts) and Java (for the low-level bluetooth parts and
for interfacing with Android SDK).

Typescript parts are in app/. Java parts are in App_Resources/Android/src/main/java/com/faceclaw/app/.

If build.sh exists, it's a machine-specific wrapper that sets some environment
variables to point to where tools are installed, then runs
  `nativescript build android`.
If build_and_run.sh exists, it does everything build.sh does plus
  `nativescript run android --device <id> --justlaunch`,
which will launch the app on the developer's phone if it is plugged in and has
adb enabled. If no phone is connected, it will still build but the install step
will fail and the output will contain the string "Cannot find connected
devices." To lint and typecheck, prefer to use build.sh; if the user asks you
to run or test the app, use build_and_run.sh and then use `adb logcat` to view
the results.

If you are working on low-level communication bits, consider checking out
https://github.com/Commute773/g2-kit-unofficial/ and referring to ble/docs/
and ble/gen/ directories inside. That repository contains protobuf schemas, as
well as some communication test scripts and documentation of caveats that
come up when communicating with the headset. There may already be an existing
local checkout above this workspace at ../g2-kit-unofficial.


