# Upcoming Shift → Details morph restoration

Verified 22 September 2026. Scope: tap-to-detail transition and its reverse; existing deck swiping and navigation styling retained.

## Recovery and implementation

The working implementation used a 200 ms full-page fade. Recovered the original `pastelDetailRoute` from git commit `b896d04`, preserving the shared Schedule card-radius token.

The restored custom `PageRouteBuilder` is a shared-surface transition, not a Flutter Hero. It captures the tapped card's rectangle and pastel style once. Over 500 ms, it holds the original geometry for the first 100 ms while source content fades, interpolates position/size and radius from card to viewport, and introduces detail content in the final phase. The original title/venue handoff is preserved; text does not remain visible throughout the whole expansion. Back reverses the same animation and captured rectangle. The existing 140 ms reduced-motion alternative remains available.

The source stays painted until the destination overlay's first frame. Then the entire deck is hidden, including rear layers. Native QA identified a one-frame blank return caused by waiting for route completion before restoring the deck. Restoration now occurs on `AnimationStatus.dismissed`, before overlay removal; interaction remains locked until route completion. Early Back and reopening are covered by a regression test.

## Files changed for this request

- `lib/features/home/widgets/shift_routes.dart`: restored original `pastelDetailRoute` morph, using `ScheduleTokens.cardRadius`.
- `lib/features/home/widgets/upcoming_shift_deck.dart`: whole-deck post-frame handoff and same-frame restoration on reverse dismissal.
- `test/home_visual_states_test.dart`: restored surface-transition assertions, all-layer handoff tests at 320/393/430 widths, exact dismissal-frame restoration and early-Back cancellation coverage.
- This evidence directory: fixture/recording helpers, native video/frames, test/build logs and cleanup proof.

No backend authorization, attendance business logic or API models changed for this request. Existing unrelated working-tree changes were preserved.

## Verification

| Check | Result |
| --- | --- |
| Full `flutter test` | 224 passed; `flutter-test.log` |
| `flutter analyze` | No issues; `flutter-analyze.log` |
| Android profile APK | Passed; `android-build.log` |
| Early Back/cancel and reopen | Widget regression passed |
| Five pastel variants and reduced motion | Widget tests passed |
| Real Android forward/Back | Recorded and extracted frames visually inspected |

Final evidence: [card-final.mp4](card-final.mp4), emulator-5554, 1080×2340, profile build. Earlier `card-after` captures are diagnostic evidence of the return gap and are superseded by `card-final`.

Inspected final frames: 1.2 s source geometry/content handoff; 1.45 s expanding pastel surface; 2 s detail page; 3.6 s reverse contraction; 3.9 s foreground restored at source bounds; 4 s complete deck restored. No rear colour flashes through the foreground in inspected transition frames. Precise source-rectangle equality and dismissal-frame visibility are additionally asserted by widget tests. Native coverage in this request is Staff Upcoming Shift; no separate Venue Manager native recording is claimed.

## Disposable QA data

- Organisation: `8f0db37c-819e-4d4c-ad2a-0dd9eca1af4d`
- Workspace: `28ebe621-6540-4f9a-8b05-1d862a7e37fb`
- Venue: `ec2f017b-6bbf-4dea-96cb-6b33d7acfc84`
- Tapped shift: `d138b23f-3ef7-446e-b8a0-9497535b5bec`
- Rear shift: `9adb4206-5fbf-4456-b7d0-12eed5b8c74e`

Both shifts were confirmed for the isolated QA Staff before recording. No Clock In/Out actions or QR generation were needed for this UI-only check. Older attendance was untouched. Cleanup cancelled both QA shifts, deactivated all three QA users, removed their password hashes and revoked all refresh tokens (zero remaining). QA organisation/workspace, venue, profiles, cancelled shifts, assignments and audit history remain intentionally retained; see `cleanup-proof.json`. Private local credentials were removed after cleanup.

## Result

CARD-TO-DETAIL MORPH RESTORED: YES

REAR-LAYER GLITCH STILL FIXED: YES

BACK TRANSITION RESTORES CARD: YES

REAL EMULATOR VIDEO CHECKED: YES — recorded video inspected through extracted frames.
