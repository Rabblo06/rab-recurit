import 'package:flutter/material.dart';
import 'schedule_tokens.dart';

/// Route-local presentation only. Never stored on an offer or derived from IDs.
enum ShiftVisualStyle {
  lavender,
  yellow,
  peach,
  mint,
  blue;

  static const _slots = [lavender, yellow, peach];
  static const _list = [lavender, mint, peach, blue, yellow];
  static ShiftVisualStyle forSlot(int depth) => _slots[depth.clamp(0, 2)];
  static ShiftVisualStyle forList(int index) => _list[index % _list.length];

  Color get card => switch (this) {
    lavender => ScheduleTokens.lavender,
    yellow => ScheduleTokens.yellow,
    peach => ScheduleTokens.peach,
    mint => ScheduleTokens.mint,
    blue => ScheduleTokens.paleBlue,
  };
  Color get page => Color.lerp(ScheduleTokens.surface, card, .18)!;
  Color get clockBackground =>
      Color.lerp(ScheduleTokens.homeBackground, card, .035)!;
  Color get clockRing => Color.lerp(const Color(0xFFE4E4E9), card, .15)!;
  LinearGradient get clockSheetGradient => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      Colors.white,
      Color.lerp(Colors.white, strongBackground, .5)!,
      strongBackground,
    ],
    stops: const [0, .48, 1],
  );

  // Detail-only surfaces: deck colours and route identity remain unchanged.
  Color get strongBackground => switch (this) {
    lavender => const Color(0xFFC9C5F3),
    yellow => const Color(0xFFFFD45F),
    peach => const Color(0xFFEEC3B2),
    mint => const Color(0xFFB3D9C9),
    blue => const Color(0xFFBED7F0),
  };
  Color get neutralBackground => const Color(0xFFF7F3E8);
  Color get softBackground =>
      Color.lerp(neutralBackground, strongBackground, .25)!;
  LinearGradient get detailGradient => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [
      strongBackground,
      strongBackground,
      softBackground,
      neutralBackground,
    ],
    stops: const [0, .38, .72, 1],
  );
  Color get iconTile => Color.lerp(Colors.white, strongBackground, .6)!;
  Color get chipSurface => Color.lerp(Colors.white, strongBackground, .65)!;
  Color get metadataSurface => Color.lerp(Colors.white, strongBackground, .28)!;
  Color get noteChip => strongBackground;
  Color get surfaceBorder => Color.lerp(
    strongBackground,
    ScheduleTokens.ink,
    .3,
  )!.withValues(alpha: .24);
  Color get divider => Color.lerp(
    strongBackground,
    ScheduleTokens.ink,
    .4,
  )!.withValues(alpha: .28);
  Color get shadowTint =>
      Color.lerp(strongBackground, ScheduleTokens.ink, .65)!;
  List<BoxShadow> get iconShadows => [
    BoxShadow(
      color: shadowTint.withValues(alpha: .09),
      blurRadius: 12,
      offset: const Offset(0, 3),
    ),
  ];
  List<BoxShadow> get metadataShadows => [
    BoxShadow(
      color: shadowTint.withValues(alpha: .05),
      blurRadius: 6,
      offset: const Offset(0, 2),
    ),
  ];
  List<BoxShadow> get noteShadows => [
    BoxShadow(
      color: shadowTint.withValues(alpha: .11),
      blurRadius: 20,
      offset: const Offset(0, 6),
    ),
  ];
  Color get iconSurface => card;
  Color get metadata => Color.lerp(ScheduleTokens.surface, card, .45)!;
  Color get statusSurface => Color.lerp(ScheduleTokens.surface, card, .25)!;
  Color get noteAccent => card;
  Color get border =>
      Color.lerp(card, ScheduleTokens.ink, .18)!.withValues(alpha: .25);
  List<BoxShadow> get shadows => [
    BoxShadow(
      color: Color.lerp(card, ScheduleTokens.ink, .4)!.withValues(alpha: .08),
      blurRadius: 18,
      offset: const Offset(0, 5),
    ),
  ];
}
