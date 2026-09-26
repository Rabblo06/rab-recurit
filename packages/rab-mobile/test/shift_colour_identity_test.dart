import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/theme/shift_visual_style.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';
import 'support/motion_fixtures.dart';

void main() {
  test(
    'known IDs have fixed portable palette values; every colour is reachable',
    () {
      const expected = {
        'a': ShiftVisualStyle.peach,
        'b': ShiftVisualStyle.mint,
        'c': ShiftVisualStyle.blue,
        'd': ShiftVisualStyle.lavender,
        'e': ShiftVisualStyle.yellow,
        'abc123': ShiftVisualStyle.peach,
        'shift-1': ShiftVisualStyle.lavender,
      };
      for (final entry in expected.entries) {
        for (var repeat = 0; repeat < 100; repeat++) {
          expect(
            ShiftVisualStyle.palette[ShiftVisualStyle.preferredIndex(
              entry.key,
            )],
            entry.value,
          );
        }
      }
      expect(expected.values.toSet(), ShiftVisualStyle.values.toSet());
      expect(() => ShiftVisualStyle.forShift(''), throwsArgumentError);
    },
  );

  // All these IDs collided under direct hash modulo five.
  const colliding = ['a', 'f', 'k', 'p', 'u', 'z', 'aa'];
  test(
    'five colliding IDs exhaust palette before reuse and avoid neighbours',
    () {
      final registry = ShiftColourRegistry()..registerGroup(colliding);
      final colours = colliding.map(registry.resolve).toList();
      expect(colours.take(5).toSet(), ShiftVisualStyle.palette.toSet());
      for (var i = 1; i < colours.length; i++) {
        expect(colours[i], isNot(colours[i - 1]));
      }
      for (final id in colliding) {
        expect(registry.resolve(id), colours[colliding.indexOf(id)]);
      }
    },
  );

  test(
    'registration, filtering, duplicates and insertion never recolour known IDs',
    () {
      final registry = ShiftColourRegistry()..registerGroup(colliding);
      final before = {for (final id in colliding) id: registry.resolve(id)};
      registry.registerGroup(colliding.reversed);
      registry.registerGroup(['new', 'p', 'a', 'p']);
      for (final entry in before.entries) {
        expect(registry.resolve(entry.key), entry.value);
      }
    },
  );

  test('new group avoids already-known nearby colours', () {
    final registry = ShiftColourRegistry();
    final existing = registry.resolve('a');
    registry.registerGroup(['f', 'a', 'k', 'p', 'u']);
    expect(registry.resolve('a'), existing);
    expect(['f', 'a', 'k', 'p', 'u'].map(registry.resolve).toSet().length, 5);
  });

  test('session allocation is repeatable for the same discovery sequence', () {
    final first = ShiftColourRegistry()..registerGroup(colliding);
    final restarted = ShiftColourRegistry()..registerGroup(colliding);
    for (final id in colliding) {
      expect(first.resolve(id), restarted.resolve(id));
    }
    expect(() => first.registerGroup(['new-id', '']), throwsArgumentError);
  });

  test('Staff offer and VM event use the underlying Shift, never offer id', () {
    for (final offer in motionOffers(5)) {
      final event = VenueEvent(
        {'id': offer.shiftId},
        role: offer.roleName,
        venue: offer.venueName,
      );
      expect(event.shiftId, offer.shiftId);
      expect(event.shiftId, isNot(offer.id));
      expect(
        ShiftVisualStyle.forShift(event.shiftId).card,
        ShiftVisualStyle.forShift(offer.shiftId).card,
      );
    }
  });

  test(
    'reorder, filter, reload and separate model instances retain colours',
    () {
      final original = motionOffers(10);
      final expected = {
        for (final o in original)
          o.shiftId: ShiftVisualStyle.forShift(o.shiftId),
      };
      for (final records in [
        original.reversed,
        original.skip(3),
        motionOffers(10),
      ]) {
        for (final record in records) {
          expect(
            ShiftVisualStyle.forShift(record.shiftId),
            expected[record.shiftId],
          );
        }
      }
    },
  );
}
