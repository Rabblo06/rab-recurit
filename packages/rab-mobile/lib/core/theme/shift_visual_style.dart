import 'package:flutter/material.dart';
import 'schedule_tokens.dart';

/// Stable presentation identity of the underlying Shift, shared by both roles.
enum ShiftVisualStyle {
  lavender,
  yellow,
  peach,
  mint,
  blue;

  /// Fixed order is a visual contract. Never reorder.
  static const palette = [lavender, yellow, peach, mint, blue];

  /// One application-session registry, shared across screens and roles.
  static final registry = ShiftColourRegistry();

  static ShiftVisualStyle forShift(String shiftId) => registry.resolve(shiftId);

  static void registerGroup(Iterable<String> shiftIds) =>
      registry.registerGroup(shiftIds);

  /// Portable preferred slot, not the final collision-resolved assignment.
  static int preferredIndex(String shiftId) {
    if (shiftId.isEmpty) throw ArgumentError.value(shiftId, 'shiftId');
    var hash = 0;
    for (final unit in shiftId.codeUnits) {
      hash = (hash * 31 + unit) % 2147483647;
    }
    return hash % palette.length;
  }

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

/// UI-only, process-lifetime identity registry. Never reassigns a known shift.
/// A new process starts a new allocation session; no backend schema or identity
/// context is involved. Register whole groups before lazy card construction.
class ShiftColourRegistry {
  final _assigned = <String, int>{};
  final _usage = List<int>.filled(ShiftVisualStyle.palette.length, 0);
  int? _last;

  ShiftVisualStyle resolve(String shiftId) {
    final known = _assigned[shiftId];
    if (known != null) return ShiftVisualStyle.palette[known];
    return ShiftVisualStyle.palette[_allocate(shiftId, _usage, _last)];
  }

  void registerGroup(Iterable<String> shiftIds) {
    final ids = shiftIds.toSet().toList();
    // Validate before mutating, including records not yet rendered.
    for (final id in ids) {
      ShiftVisualStyle.preferredIndex(id);
    }
    final usage = List<int>.filled(_usage.length, 0);
    for (final id in ids) {
      final slot = _assigned[id];
      if (slot != null) usage[slot]++;
    }
    int? previous;
    for (final id in ids) {
      final known = _assigned[id];
      final slot = known ?? _allocate(id, usage, previous);
      if (known == null) usage[slot]++;
      previous = slot;
    }
  }

  int _allocate(String id, List<int> nearbyUsage, int? previous) {
    final preferred = ShiftVisualStyle.preferredIndex(id);
    final least = nearbyUsage.reduce((a, b) => a < b ? a : b);
    final candidates = List.generate(
      _usage.length,
      (offset) => (preferred + offset) % _usage.length,
    )..removeWhere((slot) => nearbyUsage[slot] != least);
    if (candidates.length > 1) candidates.remove(previous);
    final slot = candidates.first;
    _assigned[id] = slot;
    _usage[slot]++;
    _last = slot;
    return slot;
  }
}
