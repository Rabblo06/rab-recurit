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
  static const peach = Color(0xFFF6E7DF);
  static const mint = Color(0xFFDDEFE9);
  static const lavender = Color(0xFFDFE2FF);
  static const yellow = Color(0xFFFFDA79);
  static const paleBlue = Color(0xFFDCEAFB);
  static const danger = Color(0xFFC9604F);
  static const dangerSoft = Color(0xFFF6E4E0);
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
  static const label = TextStyle(fontSize: 12, height: 1.35, color: muted);
  static const body = TextStyle(fontSize: 14, height: 1.35, color: ink);
  static BoxDecoration panel(Color color, {bool lifted = false}) =>
      BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(panelRadius),
        boxShadow: lifted ? shadows : null,
      );
}
