import 'package:flutter/material.dart';

/// Schedule presentation only; Classic's palette is deliberately independent.
abstract final class ScheduleTokens {
  static const homeBackground = Color(0xFFF7F7F9);
  static const homePeach = Color(0xFFF8ECDF);
  static const homeMint = Color(0xFFE2F2EC);
  static const homeInset = 24.0;
  static const homeSectionGap = 20.0;
  static const homeShadows = [
    BoxShadow(color: Color(0x0927213C), blurRadius: 12, offset: Offset(0, 3)),
  ];
  static const background = Color(0xFFF7F6FB);
  static const surface = Colors.white;
  static const ink = Color(0xFF171B19);
  static const muted = Color(0xFF797B80);
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

  /// The 3-slot stack used by the swipeable deck — front/mid/back, indexed
  /// by [depth] (0 = front). Kept separate from [expandedPalette] below:
  /// the deck's colors belong to the *visual slot* a card currently
  /// occupies (front/mid/back), continuously interpolated as cards move
  /// through the stack during a swipe — never to the shift/offer itself.
  static Color stackColorForDepth(double depth) {
    final clamped = depth.clamp(0.0, 2.0);
    final backing = Color.lerp(yellow, peach, (clamped - 1).clamp(0.0, 1.0))!;
    return Color.lerp(lavender, backing, clamped.clamp(0.0, 1.0))!;
  }

  /// The flat, scrollable "View all" list has no stack depth once settled —
  /// each row keeps one fixed, distinct color for its own list position
  /// (cycling through this palette), so scrolling never converges every
  /// card to the same color the way depth-based coloring alone would.
  static const expandedPalette = [lavender, mint, peach, paleBlue, yellow];
  static Color expandedColorForIndex(int index) =>
      expandedPalette[index % expandedPalette.length];
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
        borderRadius: BorderRadius.circular(24),
        boxShadow: lifted ? shadows : null,
      );
}
