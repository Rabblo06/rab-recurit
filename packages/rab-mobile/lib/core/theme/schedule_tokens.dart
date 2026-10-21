import 'package:flutter/material.dart';

/// Schedule presentation only; Classic's palette is deliberately independent.
abstract final class ScheduleTokens {
  static const homeBackground = Color(0xFFF7F7F9);
  static const homePeach = Color(0xFFF8ECDF);
  static const homeMint = Color(0xFFE2F2EC);
  static const homeInset = 24.0;
  static const homeSectionGap = 20.0;
  static const touchTarget = 48.0;
  static const cardRadius = 28.0;
  static const panelRadius = 24.0;
  static const rowRadius = 20.0;
  static const fieldRadius = 12.0;
  static const badgeRadius = 16.0;
  static const cardInset = 16.0;
  static const sheetRadius = 32.0;
  static const sheetInset = 24.0;
  static const sheetTextGap = 12.0;
  static const sheetActionGap = 20.0;
  static const navigationInset = 24.0;
  static const navigationBottom = 12.0;
  static const navigationWidthFactor = .90;
  static const navigationMaxWidth = 440.0;
  static const navigationHeight = 72.0;
  static const navigationPadding = 8.0;
  static const navigationActiveSize = 54.0;
  static const navigationIconSize = 24.0;
  static const homeShadows = [
    BoxShadow(color: Color(0x0927213C), blurRadius: 12, offset: Offset(0, 3)),
  ];
  static const background = Color(0xFFF7F6FB);
  static const surface = Colors.white;
  static const ink = Color(0xFF171B19);
  // 4.53:1 on lavender and 4.84:1 on mint for small secondary text.
  static const muted = Color(0xFF62666B);
  static const accent = Color(0xFF050908);
  // Dark summary surfaces (Teams card) and selected filter chips.
  static const navy = Color(0xFF0D1B33);
  // Shift identity pastels (owner reference: Offers cards).
  static const peach = Color(0xFFFFF2E9);
  static const mint = Color(0xFFECFCF5);
  static const lavender = Color(0xFFDFE2FF);
  static const yellow = Color(0xFFFFDA79);
  static const paleBlue = Color(0xFFDCEAFB);
  static const danger = Color(0xFFC9604F);
  static const dangerSoft = Color(0xFFF6E4E0);
  // Feedback text on the schedule UI's light cards (including tinted cards).
  static const errorText = Color(0xFFC62828);
  static const successText = Color(0xFF18713B);
  // Temporary feedback (ScheduleToast): white card, thin border, soft shadow,
  // and a very light semantic fill that drains with the remaining time. Text
  // stays >= 4.5:1 on both white and the fill.
  static const toastRadius = 12.0;
  static const toastBorder = Color(0x1F171B19);
  static const toastShadows = [
    BoxShadow(color: Color(0x1A101828), blurRadius: 16, offset: Offset(0, 6)),
  ];
  static const toastErrorFill = Color(0xFFFDECEC);
  static const toastSuccessFill = Color(0xFFE7F6EC);
  static const toastWarningFill = Color(0xFFFFF3DC);
  static const toastInfoFill = Color(0xFFE8F0FE);
  static const warningText = Color(0xFFB54708);
  static const warningIcon = Color(0xFFDC8A06);
  static const infoIcon = Color(0xFF2563EB);
  static const successIcon = Color(0xFF1F8A4C);
  static const edge = Color(0x408DDDD2);
  static const border = Color(0x22797B80);

  static const shadows = [
    BoxShadow(color: Color(0x0D27213C), blurRadius: 18, offset: Offset(0, 6)),
  ];
  static const segmentMotion = Duration(milliseconds: 300);
  static const styleMotion = Duration(milliseconds: 250);
  static const heading = TextStyle(
    fontSize: 20,
    fontWeight: FontWeight.w600,
    color: ink,
  );
  static const label = TextStyle(fontSize: 13, height: 1.35, color: muted);
  static const body = TextStyle(fontSize: 15, height: 1.35, color: ink);
  static const actionHeight = 54.0;
  static const actionInset = 20.0;
  static BoxDecoration panel(Color color, {bool lifted = false}) =>
      BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(panelRadius),
        boxShadow: lifted ? shadows : null,
      );
}

/// The staff app's single type scale. Sizes are logical pixels and scale with
/// the user's system text size (never overridden). Screens pick a role from
/// here instead of hardcoding a `fontSize`.
abstract final class ScheduleType {
  static const pageTitle = TextStyle(
    fontSize: 26,
    height: 1.2,
    fontWeight: FontWeight.w700,
    color: ScheduleTokens.ink,
  );
  static const navTitle = TextStyle(
    fontSize: 19,
    height: 1.25,
    fontWeight: FontWeight.w600,
    color: ScheduleTokens.ink,
  );
  static const venueTitle = TextStyle(
    fontSize: 19,
    height: 1.25,
    fontWeight: FontWeight.w600,
    color: ScheduleTokens.ink,
  );
  static const cardTitle = TextStyle(
    fontSize: 18,
    height: 1.25,
    fontWeight: FontWeight.w700,
    color: ScheduleTokens.ink,
  );
  static const body = TextStyle(
    fontSize: 15,
    height: 1.4,
    color: ScheduleTokens.ink,
  );
  static const bodyStrong = TextStyle(
    fontSize: 15,
    height: 1.4,
    fontWeight: FontWeight.w600,
    color: ScheduleTokens.ink,
  );
  static const secondary = TextStyle(
    fontSize: 14,
    height: 1.4,
    color: ScheduleTokens.muted,
  );
  static const caption = TextStyle(
    fontSize: 13,
    height: 1.35,
    color: ScheduleTokens.muted,
  );
  static const overline = TextStyle(
    fontSize: 12,
    height: 1.3,
    fontWeight: FontWeight.w600,
    letterSpacing: .6,
    color: ScheduleTokens.muted,
  );
  static const badge = TextStyle(
    fontSize: 13,
    height: 1.2,
    fontWeight: FontWeight.w600,
  );
  static const button = TextStyle(
    fontSize: 16,
    height: 1.2,
    fontWeight: FontWeight.w600,
  );
  static const timer = TextStyle(
    fontSize: 52,
    height: 1.05,
    fontWeight: FontWeight.w400,
    color: ScheduleTokens.ink,
    fontFeatures: [FontFeature.tabularFigures()],
  );
  static const timerLabel = TextStyle(
    fontSize: 12,
    height: 1.2,
    fontWeight: FontWeight.w600,
    letterSpacing: .8,
    color: ScheduleTokens.muted,
  );
}
