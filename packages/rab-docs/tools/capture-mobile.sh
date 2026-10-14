#!/usr/bin/env bash
# Crewflow mobile docs capture — replays the exact adb sequences used to
# produce images/mobile/raw/*.png and videos/raw-mobile/*.mp4 (+ captions).
#
# Prerequisites (see MOBILE_CAPTURE.md):
#   * fixture server running:  node tools/mobile-fixture-server.cjs   (port 4010)
#   * Pixel_5 emulator (1080x2340, 440 dpi) booted, app installed from a debug
#     build with --dart-define=API_URL=http://10.0.2.2:4010/rest/v1
#   * optional: a fingerprint enrolled on the emulator (for the biometric shots)
#
# Usage (Git Bash):
#   tools/capture-mobile.sh staff        # staff screenshots
#   tools/capture-mobile.sh vm           # venue-manager screenshots
#   tools/capture-mobile.sh rec-accept   # recording (a) staff-accept-offer
#   tools/capture-mobile.sh rec-tour     # recording (b) staff-app-tour
#   tools/capture-mobile.sh rec-send     # recording (c) venue-send-shift
#   tools/capture-mobile.sh all
#
# Coordinates are for the Pixel_5 AVD at 1080x2340. Element-driven steps use
# tap_el (uiautomator + Flutter semantics); fixed taps are commented with the
# element they hit. The emulator used for the original capture was slow
# (2 GB RAM, software GLES), so pauses are generous.
set -u
source "$(dirname "${BASH_SOURCE[0]}")/capture-lib.sh"

VID="$DOCS_DIR/videos/raw-mobile"
mkdir -p "$VID"

# ------------------------------------------------------------ helpers ----
type_slow() { # type text in chunks so the slow debug build never drops keys
  # The first key event after a field gains focus was sometimes delivered
  # twice on the slow emulator ("aalex..."), so prime the field with a
  # throwaway character and delete it first.
  type_text x; sleep 1; adb_ shell input keyevent KEYCODE_DEL; sleep 0.8
  local w; for w in "$@"; do type_text "$w"; sleep 0.9; done
}

# AuthFlowShell's docked-sheet transition (login -> biometric setup) races
# its own reveal animation on a slow device and can leave the sheet blank.
# Turning the animator off for the login steps avoids it; recordings turn
# it back on once Home is reached.
anim_off() { adb_ shell settings put global animator_duration_scale 0; }
anim_on() { adb_ shell settings delete global animator_duration_scale >/dev/null; }

login() { # login <email words...>  — from a fresh app (onboarding)
  anim_off
  fresh_app
  wait_el "Get Started" 40 || return 1
  sleep 1
  tap 540 2065                                  # Get Started
  wait_el "Sign in to your account" 15
  sleep 1
  tap 540 1380; sleep 3                          # EMAIL field
  type_slow "$@"
  back; sleep 1.5                                # hide keyboard only
  tap 480 1613; sleep 3                          # PASSWORD field
  type_slow Demo Pass 123
  back; sleep 2
}

sign_in() {
  tap_el "/^Sign In$/"
  sleep 8
}

skip_biometric() { # dismiss the post-login biometric offer if it appears
  if find_el "Skip for now" >/dev/null 2>&1; then tap_el "Skip for now"; sleep 4; fi
}
ready_for_recording() { # settle, restore animations, clean status bar
  sleep 3; anim_on; adb_ shell am kill-all; clean_status_bar; sleep 3
}

# ------------------------------------------------------------ recording --
REC_NAME=""; REC_T0=0; REC_MARKS=""
now_s() { node -e "process.stdout.write((Date.now()/1000).toFixed(2))"; }
# Recording mode:
#   REC_MODE=host   (default) — the emulator console's own recorder
#                   (`adb emu screenrecord`), encoded on the HOST at a constant
#                   30 fps, then transcoded to H.264 MP4 with ffmpeg. Used for
#                   the delivered videos: the in-guest encoder below starved
#                   the 2 GB emulator and produced ~1.7 fps footage.
#   REC_MODE=device — `adb shell screenrecord --bit-rate 8000000 --size 720x1560`
#                   (fine on a real device or a well-resourced emulator).
REC_MODE="${REC_MODE:-host}"
FFMPEG="${FFMPEG:-ffmpeg}"
rec_start() {
  REC_NAME="$1"; REC_MARKS="$VID/$1.marks.tsv"; : > "$REC_MARKS"
  if [ "$REC_MODE" = host ]; then
    REC_WEBM="$VID/$1.webm"; rm -f "$REC_WEBM"
    adb_ emu screenrecord start --time-limit 180 --fps 30 "$(winpath "$REC_WEBM")" >/dev/null
  else
    adb_ shell rm -f "/sdcard/$1.mp4" >/dev/null 2>&1
    adb_ shell screenrecord --bit-rate 8000000 --size 720x1560 "/sdcard/$1.mp4" &
    REC_PID=$!
    sleep 1.0                   # screenrecord needs ~1s before frames flow
  fi
  REC_T0=$(now_s)
}
mark() { # mark "caption" — caption starts now
  printf '%s\t%s\n' "$(node -e "process.stdout.write(((Date.now()/1000)-$REC_T0).toFixed(1))")" "$1" >> "$REC_MARKS"
}
rec_stop() {
  local dur; dur=$(node -e "process.stdout.write(((Date.now()/1000)-$REC_T0).toFixed(1))")
  if [ "$REC_MODE" = host ]; then
    adb_ emu screenrecord stop >/dev/null
    sleep 4
    "$FFMPEG" -y -hide_banner -loglevel error -i "$(winpath "$REC_WEBM")" -t "$dur" -an \
      -vf "scale=720:1560:flags=lanczos,fps=30,format=yuv420p" \
      -c:v libx264 -preset slow -crf 18 -b:v 0 -maxrate 8M -bufsize 16M -movflags +faststart \
      "$(winpath "$VID/$REC_NAME.mp4")"
    rm -f "$REC_WEBM"
  else
    adb_ shell pkill -INT screenrecord
    wait "$REC_PID" 2>/dev/null
    sleep 2
    adb_ pull "/sdcard/$REC_NAME.mp4" "$(winpath "$VID/$REC_NAME.mp4")" >/dev/null
    adb_ shell rm -f "/sdcard/$REC_NAME.mp4"
  fi
  node -e '
    const fs=require("fs");const [marks,dur,out]=process.argv.slice(1);
    const rows=fs.readFileSync(marks,"utf8").trim().split(/\r?\n/).filter(Boolean).map(l=>{const i=l.indexOf("\t");return{start:+l.slice(0,i),text:l.slice(i+1)}});
    const caps=rows.map((r,i)=>({start:Math.max(0,r.start),end:+(i+1<rows.length?rows[i+1].start-0.2:+dur).toFixed(1),text:r.text}));
    fs.writeFileSync(out,JSON.stringify(caps,null,2)+"\n");' \
    "$(winpath "$REC_MARKS")" "$dur" "$(winpath "$VID/$REC_NAME.captions.json")"
  rm -f "$REC_MARKS"
  echo "  recorded $REC_NAME.mp4 (${dur}s)"
}

# ------------------------------------------------------------- staff -----
staff_shots() {
  echo "== staff screenshots"
  fixture_reset; clean_status_bar; anim_off
  fresh_app
  wait_el "Get Started" 40; sleep 1
  tap 882 202; sleep 1.3                         # "Welcome" page dot (carousel auto-advances)
  shot staff-01-onboarding
  tap 540 2065                                   # Get Started
  wait_el "Sign in to your account" 15; sleep 1.5
  shot staff-02-login-empty
  tap 540 1380; sleep 3; type_slow alex. morgan @example .test
  back; sleep 2
  tap 480 1613; sleep 3; type_slow Demo Pass 123
  back; sleep 2
  shot staff-03-login-filled

  tap 857 1512                                   # Forgot password?
  wait_el "Send reset link" 10; sleep 1
  back; sleep 2                                  # hide the IME (field autofocuses)
  shot staff-forgot-password
  tap 540 1488                                   # Send reset link
  wait_el "Check your email" 10; sleep 1
  shot staff-forgot-password-sent
  tap 540 1458                                   # Return to sign in
  sleep 3
  find_el "/^Sign In$/" >/dev/null 2>&1 || { back; sleep 1.5; }

  sign_in
  if find_el "Enable Passkey" >/dev/null 2>&1; then
    sleep 1; shot staff-03b-biometric-setup
    tap_el "Enable Passkey"; sleep 3               # system prompt is FLAG_SECURE (black in screencap)
    adb_ emu finger touch 1 >/dev/null; sleep 1; adb_ emu finger remove 1 >/dev/null
    sleep 5
  fi
  wait_el "Open Shift Offers" 20; sleep 3
  shot staff-04-home-organization
  tap 770 502; sleep 2.5                         # My Space
  shot staff-05-home-my-space
  tap 300 502; sleep 2                           # organization

  tap 900 1100; sleep 3.5                        # Open Shift Offers card
  shot staff-06-offers-pending
  tap 926 444; sleep 4                           # "Open Bartender" (first offer)
  shot staff-07-job-details-pending
  tap 790 2170; sleep 3.5                        # Accept
  shot staff-07b-job-details-after-accept
  back; sleep 3
  shot staff-08-offers-waiting-confirmation
  fixture_confirm_latest
  swipe 540 700 540 1700 500; sleep 4            # pull to refresh
  tap 1014 213; sleep 3.5                        # Confirmed (app bar action)
  shot staff-09-confirmed-list
  back; sleep 1.5; back; sleep 2

  tap 424 2175; sleep 3.5                        # Calendar tab
  shot staff-10-calendar-today
  swipe 540 1800 540 1000 600; sleep 2
  shot staff-10b-calendar-today-scrolled
  swipe 540 800 540 1900 400; sleep 2            # back to top (toggle scrolls away)
  tap 784 394; sleep 3                           # Month
  shot staff-11-calendar-month
  tap 296 394; sleep 1.5                         # back to Today
  swipe 540 800 540 1900 400; sleep 1.5          # scroll the agenda back to the top

  tap 655 2175; sleep 3.5                        # History tab
  shot staff-14-history
  tap 886 2175; sleep 3                          # Profile tab
  shot staff-15-profile
  tap 540 846; sleep 3                           # Security
  shot staff-16-security
  back; sleep 2
  tap 540 670; sleep 3.5                         # Inbox -> Notifications
  shot staff-17-notifications
  back; sleep 1.5

  tap 194 2175; sleep 2.5                        # Home tab
  tap 805 1300; sleep 4                          # "Clock in" tile
  shot staff-12-clock-ready
  tap 540 2175; sleep 3                          # Clock in
  if find_el "Confirm you're on site" >/dev/null 2>&1; then
    shot staff-13-location-explainer
    adb_ emu geo fix -2.5935 51.4496 >/dev/null
    tap_el "/^Continue$/"; sleep 4
    if find_el "While using the app" >/dev/null 2>&1; then
      shot staff-13b-location-os-prompt
      tap_el "While using the app"; sleep 6
    fi
    if find_el "take pictures" >/dev/null 2>&1; then
      shot staff-13d-camera-os-prompt
      tap_el "While using the app"; sleep 6
    fi
  fi
  wait_el "Scan the shift QR code" 15; sleep 8   # let the virtual camera start
  shot staff-13c-qr-scanner
  back; sleep 2
}

# ------------------------------------------------------- venue manager ---
# FAST=1 replaces the uiautomator waits with fixed sleeps (a dump takes
# several seconds on the slow emulator, which bloats recordings).
waitf() { if [ "${FAST:-0}" = 1 ]; then sleep "${2:-2.5}"; else wait_el "$1" 8; fi; }
settime() { # settime <x of start/end field> <hour 1-12> — PM, text-entry mode
  tap "$1" 914
  waitf "Switch to text input mode" 2.5; tap 180 1783
  waitf "Switch to dial picker" 2
  tap 287 1117; sleep 1
  adb_ shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A; adb_ shell input keyevent KEYCODE_DEL
  type_text "$2"; sleep 1
  tap 853 1183; sleep 1                          # PM
  tap 837 1436; sleep 2                          # OK
}
fill_send_form() {
  waitf "Select venue" 1.5; sleep 1
  tap 288 461; waitf "Kingsway Rooms" 2; sleep 0.8
  tap 300 461; sleep 2                           # The Grand Hall
  tap 792 461; waitf "Banquet Server" 2; sleep 0.8
  tap 786 461; sleep 2                           # Bartender
  settime 288 5                                  # 17:00
  settime 792 11                                 # 23:00
}
pick_staff() {
  tap 898 1371                                   # Select staff
  waitf "Alex Morgan" 4; sleep 2
  tap 540 867; sleep 1.2                         # Alex Morgan
  tap 540 1274; sleep 1.2                        # Sam Okafor
  tap 540 1681; sleep 1.5                        # Casey Williams
}

vm_shots() {
  echo "== venue manager screenshots"
  fixture_reset; clean_status_bar
  login riley. chen @example .test
  sign_in; skip_biometric
  wait_el "Open positions" 20; sleep 3
  shot vm-01-home-organization
  tap 770 502; sleep 2.5                         # My Space
  shot vm-02-home-my-space
  tap 540 1346; sleep 4                          # Sent offers
  shot vm-03-sent-shifts
  swipe 540 1900 540 1200 500; sleep 2
  tap 926 2060; sleep 3.5                        # "View sent shift" on Event Steward (today)
  shot vm-04-sent-shift-detail
  back; sleep 2
  tap 970 218; sleep 4                           # + Send Shift
  shot vm-05a-send-shift-empty
  fill_send_form
  pick_staff
  shot vm-06-select-staff
  tap 788 2142; sleep 3                          # Submit
  shot vm-05-send-shift-filled
  tap 540 2186                                   # Send Shift Offer
  wait_el "Shift submitted successfully" 15; sleep 1.5
  shot vm-07-send-shift-success
  tap 540 2142; sleep 3                          # Done
  shot vm-03b-sent-shifts-after-send
  tap 105 218; sleep 2.5                         # back to My Space

  tap 540 1500; sleep 4                          # Users
  shot vm-08-users
  tap 970 224; sleep 4                           # All Users (+)
  shot vm-09-all-users
  back; sleep 1.5; back; sleep 1.5

  tap 424 2175; sleep 3.5                        # Calendar tab
  shot vm-10-calendar
  tap 784 394; sleep 3                           # Month
  shot vm-10b-calendar-month
  tap 296 394; sleep 3                           # Today
  tap_el "Open Event Steward"; sleep 4
  shot vm-11-event-details
  back; sleep 2

  tap 194 2175; sleep 2; tap 300 502; sleep 2    # Home, organization
  tap 806 1303; sleep 3.5                        # Report
  shot vm-12-reports
  tap 540 1256; sleep 4                          # Banquet Server (yesterday) — Awaiting review
  shot vm-13-shift-report
  swipe 540 1900 540 900 600; sleep 2
  shot vm-13b-shift-report-scrolled
  tap_el "Review / Edit" 3; sleep 3              # Priya Shah (missing clock-out)
  tap 540 1372; sleep 1.5                        # "Clock out" segment
  tap 229 1559                                   # Pick a time
  wait_el "Switch to text input mode" 8; tap 180 1783; wait_el "Switch to dial picker" 8
  tap 287 1117; sleep 1
  adb_ shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A; adb_ shell input keyevent KEYCODE_DEL; type_text 6
  tap 617 1117; sleep 1
  adb_ shell input keycombination KEYCODE_CTRL_LEFT KEYCODE_A; adb_ shell input keyevent KEYCODE_DEL; type_text 05
  tap 853 1183; sleep 1; tap 837 1436; sleep 2.5 # PM, OK
  tap 540 1757; sleep 1.5                        # Reason field
  type_text "Forgot to scan out at the staff door"; sleep 2
  back; sleep 2
  shot vm-14-attendance-correction
  tap 540 2142; sleep 4                          # Save correction
  swipe 540 1900 540 900 600; sleep 2
  shot vm-14b-shift-report-after-correction
  back; sleep 1.5; back; sleep 2

  tap 655 2175; sleep 3                          # History tab
  shot vm-15-history
  tap 886 2175; sleep 3                          # Profile tab
  shot vm-16-profile
}

# ---------------------------------------------------------- recordings ---
rec_accept() {
  echo "== recording: staff-accept-offer"
  fixture_reset; clean_status_bar
  login alex. morgan @example .test
  sign_in; skip_biometric
  wait_el "Open Shift Offers" 30 || { echo "!! login did not reach Home - aborting recording" >&2; return 1; }; ready_for_recording
  rec_start staff-accept-offer
  mark "Home shows today's shift and your open shift offers"
  pause 3
  mark "Tap Open Shift Offers to see new invitations"
  tap 900 1100; pause 3.5
  mark "Each offer shows the venue, date, pay rate and estimated pay"
  pause 3
  mark "Open the offer to see pay, time, location and notes"
  tap 926 444; pause 5
  mark "Tap Accept to take the shift"
  tap 790 2170; pause 3.5
  mark "Accepted offers wait for the venue manager to confirm"
  back; pause 4.5
  fixture_confirm_latest >/dev/null
  mark "The manager confirms - pull down to refresh"
  swipe 540 700 540 1700 500; pause 4
  mark "Confirmed shifts move to your Confirmed list"
  tap 1014 213; pause 5
  rec_stop
}

rec_tour() {
  echo "== recording: staff-app-tour"
  fixture_reset; clean_status_bar
  login alex. morgan @example .test
  sign_in; skip_biometric
  wait_el "Open Shift Offers" 30 || { echo "!! login did not reach Home - aborting recording" >&2; return 1; }; ready_for_recording
  rec_start staff-app-tour
  mark "Home: today's shift, open offers and the clock-in shortcut"
  pause 3
  mark "Your next confirmed shifts are stacked under Upcoming Shift"
  pause 3
  mark "My Space gives a quick overview of offers and confirmed shifts"
  tap 770 502; pause 4
  tap 300 502; pause 1.5
  mark "Calendar: your week at a glance"
  tap 424 2175; pause 3.5
  swipe 540 1800 540 1100 700; pause 2.5
  swipe 540 900 540 1600 500; pause 1.5          # back to the top so the toggle is visible
  mark "Switch to Month to see every booked day"
  tap 784 394; pause 4
  tap 296 394; pause 1.5
  mark "History lists completed shifts with hours and earnings"
  tap 655 2175; pause 4
  swipe 540 1700 540 1000 700; pause 2
  mark "Profile holds your inbox and security settings"
  tap 886 2175; pause 3.5
  mark "Notifications keep you up to date on offers and shifts"
  tap 540 670; pause 5
  back; pause 2
  rec_stop
}

rec_send() {
  echo "== recording: venue-send-shift"
  fixture_reset; clean_status_bar
  login riley. chen @example .test
  sign_in; skip_biometric
  wait_el "Open positions" 30 || { echo "!! login did not reach Home - aborting recording" >&2; return 1; }; ready_for_recording
  FAST=1
  rec_start venue-send-shift
  mark "Venue manager Home: today's event and open positions"
  pause 3
  mark "Open My Space for your staffing overview"
  tap 770 502; pause 3
  mark "Sent offers tracks every staffing request you have sent"
  tap 540 1346; pause 4
  mark "Tap + to send a new shift"
  tap 970 218; pause 3
  mark "Choose the venue, role, date and times"
  fill_send_form; pause 1
  mark "Select staff - availability is checked for this shift window"
  pick_staff; pause 2
  mark "Confirm your team"
  tap 788 2142; pause 3
  mark "Send the shift offer"
  tap 540 2186; pause 3
  mark "Submitted - track its status from Sent Shifts"
  pause 4
  tap 540 2142; pause 4
  rec_stop; FAST=0
}

case "${1:-all}" in
  staff) staff_shots ;;
  vm) vm_shots ;;
  rec-accept) rec_accept ;;
  rec-tour) rec_tour ;;
  rec-send) rec_send ;;
  all) staff_shots; vm_shots; rec_accept; rec_tour; rec_send ;;
  *) echo "unknown target: $1" >&2; exit 2 ;;
esac
