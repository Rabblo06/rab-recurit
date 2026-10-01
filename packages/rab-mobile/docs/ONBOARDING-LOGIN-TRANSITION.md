# Adolphus Accelerating Auth Transition

2026-09-28. Motion-only refinement; both screen designs remain unchanged.

## Why previous transition felt abrupt

The actual controller used 300ms and easeInOutCubic. Much of the travel happened
in the middle of that short interval, making the visible change feel closer to
200-250ms. This was the existing shell controller, not a Hero/default route.
Replaced its timing/curve; no extra screen animation was layered on top.

## Old duration

300ms forward/Back, easeInOutCubic.

## New duration

450ms forward and 450ms Back, one AnimationController.

## Forward curve

Curves.easeInCubic: slow start, continuously increasing travel per equal interval.

## Back curve

Curves.easeOutCubic applied to elapsed reverse time. Because the controller runs
from 1 to 0, position is 1 - easeOutCubic(1 - controller.value). Applying easeOut
directly to a decreasing controller would produce the opposite requested feel.

## Full-screen translation implementation

Both scenes derive the same curved travel value. Onboarding Y = -height * travel;
Login Y = height * (1 - travel). Branding, indicator, all copy/cards/images and
Get Started ride the complete onboarding scene. The two page edges stay joined,
including reversal. No separate delay/phase or independent Login reveal.

## Shared-element behavior

Unchanged secondary image/card effect: scale 1 to .97, extra lift 2.5% of viewport
height capped at 24 logical pixels. The whole-page movement remains dominant.
Get Started has no independent press animation or fade.

## Black/fade fix

Retained cream canvas, opaque page scenes and joined geometry. No modal barrier,
blank gap, root opacity animation, grey overlay or separate black intermediate
surface. Login's existing black header travels with its complete page.

## Files changed

- lib/features/welcome/onboarding_auth_motion.dart: duration/direction curves.
- lib/features/auth_flow/matched_auth_layout.dart: uses direction-aware progress.
- lib/features/auth_flow/auth_flow_shell.dart: corrected duration comment only.
- test/welcome_flow_test.dart: updated timing plus 75ms displacement regression.
- This report and repository docs/HANDOFF.md.

No onboarding/Login styling, horizontal autoplay, indicator, authentication,
backend, post-login navigation or dependency changes.

## Flutter analyze

`flutter analyze --no-pub`: no issues.

## Tests

All 53 scoped tests pass. Existing coverage includes unchanged CTA pixels,
whole-page displacement, storage-independent start, form state retention, Back,
reduced motion, responsive large text and authentication/navigation flows.
New regression checks every 75ms: strictly increasing forward distance per
interval, strictly decreasing Back distance, exact final position at 450ms and
joined page boundaries throughout.

| Elapsed | Forward distance | Back distance |
| --- | --- | --- |
| 0ms | 0% | 0% |
| 75ms | 2.17% | 43.63% |
| 150ms | 6.25% | 72.26% |
| 225ms | 14.53% | 87.51% |
| 300ms | 31.56% | 95.40% |
| 375ms | 61.16% | 99.01% |
| 450ms | 100% | 100% |

These are actual widget-rendered scene offsets at a 600px test viewport, not
estimated native frame-rate scores.

## Visual QA

Android profile build recorded and inspected in both directions. The 0/75/150/
225/300/375/450ms contact sheet confirms the gradual forward start and faster
late travel, with the complementary Back movement. Actual source-frame timestamps
are printed beside the requested sample times (the native capture is variable
rate). A fixed 30fps review copy duplicates held frames; it does not fabricate
missing motion samples or prove native 30/60fps performance.

Evidence under ignored build/onboarding-qa/:
- accelerating-auth-raw.mp4: original Android capture.
- accelerating-auth-30fps.mp4: fixed-rate review export.
- accelerating-75ms-review.jpg: both directions at requested sample intervals.

Final installed state is documented in repository docs/HANDOFF.md.
Physical-device 60fps and iOS are not certified.
