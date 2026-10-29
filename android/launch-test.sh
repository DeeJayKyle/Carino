#!/usr/bin/env bash
# Installs the APK on a running emulator, opens it, and fails unless Carino starts: no crash, and
# the in-app server (mobile/engine.ts) reports it is ready. Saves a screenshot and the log.
set -u
APK="$1"
PKG=app.carino
adb install -r "$APK" || exit 1
adb logcat -c
adb shell pm grant "$PKG" android.permission.POST_NOTIFICATIONS 2>/dev/null || true
adb shell monkey -p "$PKG" -c android.intent.category.LAUNCHER 1
ok=""
for i in $(seq 1 45); do
  sleep 2
  if adb logcat -d -s Carino:* | grep -q "Carino engine ready"; then ok=1; break; fi
done
sleep 4
adb exec-out screencap -p > screenshot.png || true
adb logcat -d > logcat.txt
echo "---- Carino log ----"
grep -E "AndroidRuntime| Carino|$PKG" logcat.txt | tail -80
# Only Carino's own crashes count (the emulator's preinstalled apps crash now and then).
if grep -A 1 "FATAL EXCEPTION" logcat.txt | grep -q "Process: $PKG"; then
  echo "---- CRASH ----"
  grep -A 40 "FATAL EXCEPTION" logcat.txt | grep -A 39 "Process: $PKG"
  exit 1
fi
if grep -q "FATAL EXCEPTION" logcat.txt; then
  echo "(Another app on the emulator crashed: $(grep -A 1 "FATAL EXCEPTION" logcat.txt | grep -o "Process: [^,]*" | sort -u | tr '\n' ' '); not Carino.)"
fi
if [ -z "$ok" ]; then
  echo "Carino did not report that it started (no 'Carino engine ready' in the log)."
  exit 1
fi
echo "Carino started on the emulator."
