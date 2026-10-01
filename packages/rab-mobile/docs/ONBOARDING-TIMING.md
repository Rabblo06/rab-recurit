# Adolphus Onboarding Timing Refinement

Date: 2026-09-28. Motion and indicator only; existing settled design preserved.

## Previous timing

Five seconds of idle followed by 900ms movement produced a roughly 5.9-second
cycle, with sampled native cadence around 5.9-6.0 seconds. The entire indicator
previously occupied three separate 48px control slots.

## New timing

One four-second cadence token minus the 650ms page transition gives 3350ms idle.
The existing single cancellable timer starts only after scrolling settles;
there is no extra four-second delay. animateToPage uses easeInOutCubic. Virtual
pages still map modulo three for smooth 3-to-1 looping. No automatic login.

Content uses 400ms easeOutCubic entrances over 24px. Each page owns its arrival
controller, triggered as that page crosses the halfway point into view, so
content starts while the page is still settling. Settled positions are unchanged.

## Indicator dimensions

Active 18x3px; inactive 4x4px circles; 8px visible gaps; 42px total visual width.
200ms easeOutCubic AnimatedContainer transitions, radius 2px. Retained the old
144x48 header allocation and top-right anchor, so branding and all content below
it do not move. Existing individual page selection, tooltips and keyboard
activation remain available. Control height remains 48px.

## Page 2 animation timing

Housekeeping 50ms; headline 100ms; reception 150ms; dining image plus its label
200ms; description 250ms. Each lasts 400ms, with left/right 24px motion.
CTA slides upward 24px at 300ms for 400ms. Starts while the page enters; no
post-transition wait before beginning the sequence.

## Page 3 animation timing

Headline 0ms; Best Match 60ms from left; profile match 120ms from right;
strengths 180ms from left; opportunities 240ms from right. Each lasts 400ms.
CTA: same 300ms delay / 400ms upward entrance. Typography, cards and spacing
unchanged. Page 1's original entrance and clipped hero remain unchanged.

## Manual swipe timer reset

Pointer down and scroll start cancel the timer. Pointer release/scroll settling
start a fresh full cycle: 3350ms idle + 650ms movement. No leftover time from the
previous page. Every reset cancels the previous timer. Reduced motion disables
auto movement and content transitions; manual selection remains available.
Backgrounding, disabled tickers and completion suspend automatic movement.
Dispose cancels the timer and removes/disposes controllers and listeners.

## Files changed

- lib/features/welcome/onboarding_motion.dart: timing tokens and short slide primitive.
- lib/features/welcome/onboarding_page.dart: page-local arrival controller and item stagger.
- lib/features/welcome/welcome_header.dart: compact indicator and CTA arrival.
- test/onboarding_motion_test.dart: revised cadence plus exact dimensions/geometry tests.
- docs/ONBOARDING-TIMING.md and canonical repository docs/HANDOFF.md: verification record.

## Verification

Flutter analysis clean. 31 scoped tests pass: motion, exact four-second timing,
indicator dimensions, responsive layouts, manual timer reset, reduced motion,
lifecycle pause, page clipping, welcome persistence and existing auth/root flow.
Android debug build succeeds and is installed on emulator-5556.

Measured unchanged chrome at a 393x851 widget viewport: branding left=24;
page area Rect(0,48,393,735); CTA text bounds unchanged before/after the indicator
edit. Tests check these page/header invariants and exact 42px indicator span.
Existing layout tests cover six viewport sizes with 100%, 125% and 200% text.

## Visual QA

Inspected a 28-second native recording covering two complete 1-2-3-1 cycles at
1080x2340, density 440 (~393x851 logical). Measured transition start intervals:
4.024, 4.023, 4.043, 4.003, 4.113 and 4.033 seconds. Native frames show content
finishing within about 0.4 seconds of page settling, with no hanging pause,
duplicate-page flash or neighboring-image fragments at rest. Short content
entrances, compact indicator and unchanged settled layouts inspected.

Artifacts (local/ignored): build/onboarding-qa/onboarding-timing.mp4,
timing-contact-sheet.jpg, timing-evidence.json, timing-installed.png.
Logs: build/timing-analyze.log, timing-tests.log, timing-build.log.
No release deployment, native iOS testing or frame-rate certification.
