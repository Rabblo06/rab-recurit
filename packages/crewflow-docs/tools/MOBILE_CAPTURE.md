# Capturing the Crewflow mobile app for the docs

Real screenshots and screen recordings of the Flutter staff / venue-manager
app (`packages/rab-mobile`), driven on an Android emulator against a
**synthetic fixture API**. Nothing here touches the real backend (port 3000),
any database, Redis or real user data, and nothing in `packages/rab-mobile`
is modified.

| File | Purpose |
| --- | --- |
| `mobile-fixture-server.cjs` | Dependency-free Node HTTP server (port 4010) that answers every endpoint the app calls, with fictional data shaped exactly like the app's Dart models. Stateful (accept / confirm / send shift / attendance correction). |
| `capture-lib.sh` | Bash helpers: `shot`, `tap`, `swipe`, `type_text`, uiautomator-based `find_el` / `tap_el` / `wait_el`, `clean_status_bar`, `fresh_app`, fixture reset/confirm. |
| `ui-find.cjs` | Reads a `uiautomator dump` and prints the centre of the node whose text / content-desc matches (Flutter semantics labels appear as content-desc). `--list` prints every labelled node. |
| `capture-mobile.sh` | Replays the exact tap sequences: `staff`, `vm`, `rec-accept`, `rec-tour`, `rec-send`, `all`. |

Outputs:

* `../images/mobile/raw/*.png` — 1080x2340 PNG screenshots (`staff-*`, `vm-*`).
* `../videos/raw-mobile/*.mp4` — 720x1560 H.264 portrait recordings, each with a
  `<name>.captions.json` timeline: `[{ "start": s, "end": s, "text": "..." }]`,
  measured from the scripted tap timestamps relative to recording start.

## 1. Start the fixture server

```bash
node packages/crewflow-docs/tools/mobile-fixture-server.cjs        # PORT=4011 to change
```

Personas (picked by the login email; **any password** is accepted):

| Email | Roles | Name |
| --- | --- | --- |
| `alex.morgan@example.test` | `['staff']` | Alex Morgan |
| `riley.chen@example.test` | `['venue_manager']` | Riley Chen |

All shift times are relative to when the server started (Europe/London):
a confirmed *Event Steward* shift starts ~10 minutes after start-up (so the
15-minute early clock-in window is already open), three pending offers sit in
the next 1–5 days, more confirmed shifts fill the Upcoming deck, and five
completed shifts populate History (the most recent ended ~80 minutes ago so it
shows the *Complete* post-shift state; older ones show *Expired*, exactly as the
real lifecycle projection does).

Fixture-control endpoints (not part of the real API):

```bash
curl -X POST localhost:4010/__fixture/reset               # rebuild everything relative to "now"
curl -X POST localhost:4010/__fixture/confirm/latest      # staff_accepted -> manager_confirmed
curl -X POST localhost:4010/__fixture/confirm/<offerId>
curl localhost:4010/__fixture/state                       # dump state
```

`confirm` also emits an `offer.confirmed` SSE envelope on `/realtime/stream`,
but note the app currently never opens that stream (see *Findings*), so the
app picks the change up on pull-to-refresh or its 30-second reconcile poll.

## 2. Emulator

```bash
EMU="$LOCALAPPDATA/Android/Sdk/emulator/emulator.exe"
ADB="$LOCALAPPDATA/Android/Sdk/platform-tools/adb.exe"
"$EMU" -avd Pixel_5 -no-audio -no-boot-anim &            # windowed or -no-window
"$ADB" wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
```

Clean status bar (09:41, full battery, Wi-Fi, no notifications) — also run by
the script before every section:

```bash
source packages/crewflow-docs/tools/capture-lib.sh && clean_status_bar
```

Optional — enrol a fingerprint so the biometric offer / Security switch appear
(the original capture did this; revert with `locksettings clear --old 1111`,
which also removes the fingerprint):

```bash
"$ADB" shell locksettings set-pin 1111
"$ADB" shell am start -a android.settings.FINGERPRINT_ENROLL
# enter PIN 1111, tap through the intro, then repeat ~12x:
"$ADB" emu finger touch 1; sleep 0.6; "$ADB" emu finger remove 1; sleep 0.8
```

## 3. Build and install the app (debug)

A **debug** build is required: only `src/debug/res/xml/network_security_config.xml`
permits cleartext HTTP to `10.0.2.2`; profile/release builds block it.
`debugShowCheckedModeBanner` is already `false`, so no DEBUG ribbon appears.

```bash
cd packages/rab-mobile
C:/flutter/bin/flutter build apk --debug \
  --dart-define=API_URL=http://10.0.2.2:4010/rest/v1 \
  --dart-define=CONSOLE_URL=http://localhost:5173
"$ADB" install -r build/app/outputs/flutter-apk/app-debug.apk     # package com.rab.rab_staff
git -C ../.. status --short packages/rab-mobile                     # must be empty
```

(If `flutter build` rewrites `pubspec.lock`, restore it with
`git checkout -- packages/rab-mobile/pubspec.lock`. It did not in the original run.)

## 4. Capture

```bash
cd packages/crewflow-docs/tools
bash capture-mobile.sh staff        # staff screenshots
bash capture-mobile.sh vm           # venue-manager screenshots
bash capture-mobile.sh rec-accept   # videos/raw-mobile/staff-accept-offer.mp4 (+ captions)
bash capture-mobile.sh rec-tour     # videos/raw-mobile/staff-app-tour.mp4
bash capture-mobile.sh rec-send     # videos/raw-mobile/venue-send-shift.mp4
```

Each section resets the fixture, clears app data (`pm clear com.rab.rab_staff`),
walks onboarding → login, and then replays the taps. Coordinates are for the
Pixel_5 AVD (1080x2340, 440 dpi); element-driven steps use `tap_el`/`wait_el`.

Recording details: two modes, chosen with `REC_MODE`.

* `REC_MODE=host` (default, used for the delivered videos):
  `adb emu screenrecord start --time-limit 180 --fps 30 <file>.webm` records on
  the host, `adb emu screenrecord stop` ends it, then ffmpeg transcodes to
  H.264 MP4 (`scale=720:1560, fps=30, yuv420p, libx264 -crf 18 -maxrate 8M`,
  trimmed to the timeline length). Set `FFMPEG=/path/to/ffmpeg.exe` (the
  original run used `ffmpeg-static` from the session scratchpad).
  Why: the in-guest `screenrecord` encoder starved the 2 GB emulator and
  produced ~1.7 fps footage that missed the final step.
* `REC_MODE=device`: `adb shell screenrecord --bit-rate 8000000 --size 720x1560`
  in the background, stopped with `adb shell pkill -INT screenrecord`, then
  `adb pull` — fine on a real device or a well-resourced emulator.

720x1560 keeps the device's exact 6:13 aspect ratio (720x1600 would stretch
the image ~2.5%). Captions come from `mark "..."` calls placed immediately
before each tap; `start`/`end` are seconds from recording start, each caption
ending 0.2 s before the next begins. During the venue-manager recording
`FAST=1` swaps the uiautomator waits for fixed sleeps (a dump takes several
seconds on the slow emulator).

Before each recording the script logs in with `animator_duration_scale 0`
(see finding 1), then restores animations (`settings delete global
animator_duration_scale`), so the recorded part shows the app's real motion.

### Sequences (what the script taps)

**Login** — `fresh_app` → wait for *Get Started* → tap (540,2065) → email field
(540,1380) → type → Back (hides IME) → password field (480,1613) → type → Back →
*Sign In* → if *Enable Passkey* / *Skip for now* sheet appears, handle it.

**Staff** — Home *organization* view → *My Space* (770,502) → *organization*
(300,502) → *Open Shift Offers* card (900,1100) → *Open Bartender* ↗ (926,444) →
*Accept* (790,2170) → Back → fixture confirm → pull-to-refresh → *Confirmed*
app-bar action (1014,213) → Calendar tab (424,2175) → *Month* (784,394) / *Today*
(296,394) → History tab (655,2175) → Profile tab (886,2175) → *Security*
(540,846) → *Inbox* (540,670) → Home → *Clock in* tile (805,1300) → *Clock in*
(540,2175) → *Confirm you're on site* → *Continue* → OS location prompt → OS
camera prompt → *Scan the shift QR code*.

**Venue manager** — Home → *My Space* → *Sent offers* (540,1346) → scroll →
*View sent shift* on Event Steward → Back → **+** (970,218) → Venue dropdown
(288,461) → *The Grand Hall* → Role dropdown (792,461) → *Bartender* → Start
time (288,914) → text-input mode (180,1783) → hour 5 → PM → OK; End time
(792,914) → 11 → PM → OK → *Select staff* (898,1371) → tick Alex Morgan, Sam
Okafor, Casey Williams → *Submit* (788,2142) → *Send Shift Offer* (540,2186) →
*Shift submitted successfully* → *Done*. Then Users, All Users, Calendar
(Today/Month), Event Details, Reports → *Banquet Server* report → *Review /
Edit* (Priya Shah, missing clock-out) → *Clock out* → 18:05 → reason → *Save
correction*, History, Profile.

## 5. Notes, limits and findings

**Delivered recordings** (all 720x1560, 30 fps H.264, debug-build frame pacing):

| File | Length | Flow |
| --- | --- | --- |
| `staff-accept-offer.mp4` | 34.8 s | Home → Open Shift Offers → Job Details → Accept → "Waiting for manager confirmation" → fixture confirm → pull-to-refresh → Confirmed list |
| `staff-app-tour.mp4` | 47.7 s | Home → My Space → Calendar (Today, Month) → History → Profile → Notifications |
| `venue-send-shift.mp4` | 83.1 s | VM Home → My Space → Sent Shifts → + Send Shift → venue/role/times → Select Staff (3) → Submit → Send Shift Offer → "Shift submitted successfully" → Done. Longer than the 45–70 s target because each picker step is slow on this emulator; the 14–55 s form-filling stretch can be sped up in editing. |

**Could not be captured / limitations**

* **Clock-in / clock-out completion** — reaching the QR scanner works, but the
  emulator's virtual-scene camera cannot be pointed at a QR code from the
  command line, so `mobile_scanner` never decodes a token and the app never
  calls `/attendance/clock-in`. No "Clocked in" / live-timer / clock-out
  screens or recording were produced. (The fixture implements clock-in/out, so
  a physical device or an emulator with a webcam showing a QR would work.)
* **System biometric prompt** — Android draws it as a secure window; `screencap`
  returns a black frame, so it is not included.
* **Emulator performance** — the available Pixel_5 AVD has 2 GB RAM and the host
  was memory-constrained (~0.7 GB free); the debug build is slow, `input text`
  occasionally doubled the first key after focusing a field (the script primes
  each field with a throwaway character), and Digital Wellbeing / the app
  raised "isn't responding" dialogs. Digital Wellbeing was disabled for the
  session (`pm disable-user --user 0 com.google.android.apps.wellbeing`; re-enable
  with `pm enable com.google.android.apps.wellbeing`). Recordings therefore show
  debug-build frame pacing, not release smoothness.
* The status-bar clock is pinned to 09:41 by demo mode, while in-app times
  (greeting, shift times, "Updated at") are real wall-clock times.
* Emulator state after the original run: the temporary PIN/fingerprint was
  removed (`locksettings clear --old 1111`) before the recordings, so they log
  in without the biometric offer; Digital Wellbeing re-enabled; animator scale
  restored; `svc power stayon false`; demo mode exited. The app keeps its
  location/camera grants until `pm clear`.
* `capture-lib.sh` exports `MSYS_NO_PATHCONV=1` (so Git Bash leaves
  `/sdcard/...` alone); in a shell that sourced it, pass Windows-style paths to
  native tools (`winpath` helper).

**App findings noticed while capturing (not fixed — app code untouched)**

1. **Blank biometric-setup sheet (race).** `AuthFlowShell._transitionTo` starts
   `_reveal.reverse()` unawaited, then forwards `_sheet`; the listener only
   starts `_reveal.forward()` if `_reveal.status == dismissed` when the sheet
   passes 75%. On a slow device the reveal is still reversing at that moment,
   so the login → "Set up Biometric Login" sheet stays permanently blank (no
   content, no semantics). Captured by temporarily setting
   `animator_duration_scale 0` for the login steps.
2. **Notification timestamps are shown in UTC.** `notifications_screen.dart`
   formats `notification.createdAt` without `.toLocal()`, so during BST every
   notification time is one hour early.
3. **Shift report "Scheduled" row shows `?`** instead of an arrow/dash
   (`12 Oct 12:00 ? 12 Oct 18:00`) — a literal `?` (probably a lost `→`) in
   `venue_manager_screens.dart`.
4. **Realtime/push providers are never created.** `RealtimeConnectionService`
   and `PushRegistrationService` are registered with lazy
   `ChangeNotifierProvider(create: ...)` and nothing reads them, so the app
   never calls `/realtime/stream` or `/push/devices`; live updates rely on the
   30 s poll / pull-to-refresh.
5. Copy/branding: onboarding header reads **"ADOLPHUS / RECRUITMENT"** (not
   Crewflow); the biometric sheet is titled "Set up Biometric Login" but its
   body/button say "Setup the passkey Login" / "Enable Passkey"; the Home
   toggle label is lower-case "organization" (US spelling) next to "My Space".
6. The staff Home "N confirmed" count includes past, completed shifts (all
   `manager_confirmed` offers), e.g. "9 confirmed" with only 5 upcoming.
