import 'package:flutter/material.dart';
import 'schedule_tokens.dart';

/// Stable presentation identity of the underlying Shift, shared by both roles.
enum ShiftVisualStyle {
  mint,
  peach,
  lavender;

  /// The three approved shift identity pastels (owner Offers reference), in
  /// reference order. Fixed order is a visual contract. Never reorder.
  static const palette = [mint, peach, lavender];

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
    peach => ScheduleTokens.peach,
    mint => ScheduleTokens.mint,
  };

  /// Status pill on a shift card (e.g. "New Offer", "Confirmed").
  Color get badgeSurface => switch (this) {
    mint => const Color(0xFFCDF3E1),
    peach => const Color(0xFFFFDDC6),
    lavender => const Color(0xFFC8CDFF),
  };

  /// Badge text; at least 4.5:1 on [badgeSurface].
  Color get badgeText => switch (this) {
    mint => const Color(0xFF0B6B47),
    peach => const Color(0xFF9A4310),
    lavender => const Color(0xFF3B41A8),
  };

  /// Hairline around a pastel card, matching the reference cards.
  Color get cardBorder => Color.lerp(card, strongBackground, .55)!;

  Color get page => Color.lerp(ScheduleTokens.surface, card, .18)!;
  Color get clockBackground =>
      Color.lerp(ScheduleTokens.homeBackground, card, .035)!;
  Color get clockRing => Color.lerp(const Color(0xFFE4E4E9), card, .15)!;
  LinearGradient get clockSheetGradient => LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color.lerp(Colors.white, card, .5)!, card, strongBackground],
    stops: const [0, .45, 1],
  );

  // Detail-only surfaces: deck colours and route identity remain unchanged.
  Color get strongBackground => switch (this) {
    lavender => const Color(0xFFC5CAFF),
    peach => const Color(0xFFFFD2B5),
    mint => const Color(0xFFB4E6CF),
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

/// UI-only identity registry. Never reassigns a known shift.
/// Assignments made in this process are kept for its lifetime. When a
/// `ShiftColourStore` is attached (see `main.dart`) they are also restored on
/// the next cold start, so a shift keeps its colour after an app restart. The
/// store holds one-way hashes of shift ids, never ids or shift data, and has
/// no authorisation meaning. Register whole groups before lazy card
/// construction.
class ShiftColourRegistry {
  final _assigned = <String, int>{};
  final _usage = List<int>.filled(ShiftVisualStyle.palette.length, 0);
  final _restored = <String, int>{};
  int? _last;

  /// Called with (persistence key, slot) for every new assignment.
  void Function(String key, int slot)? onAssigned;

  /// Non-reversible persistence key: two independent bounded polynomial
  /// hashes, so the stored file never contains a shift id.
  static String persistenceKey(String shiftId) {
    var a = 0, b = 0;
    for (final unit in shiftId.codeUnits) {
      a = (a * 31 + unit) % 2147483647;
      b = (b * 131 + unit) % 2147483629;
    }
    return '${a.toRadixString(36)}.${b.toRadixString(36)}';
  }

  /// Restores assignments saved by a previous process. Out-of-range slots are
  /// ignored; ids already known in this process are never recoloured.
  void restore(Map<String, int> saved) {
    saved.forEach((key, slot) {
      if (slot >= 0 && slot < _usage.length) _restored[key] = slot;
    });
  }

  int? _known(String id) {
    final current = _assigned[id];
    if (current != null) return current;
    final saved = _restored[persistenceKey(id)];
    if (saved == null) return null;
    _assigned[id] = saved;
    _usage[saved]++;
    return saved;
  }

  ShiftVisualStyle resolve(String shiftId) {
    final known = _known(shiftId);
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
      final slot = _known(id);
      if (slot != null) usage[slot]++;
    }
    int? previous;
    for (final id in ids) {
      final known = _known(id);
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
    onAssigned?.call(persistenceKey(id), slot);
    return slot;
  }
}
