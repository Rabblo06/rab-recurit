import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/venue_manager/shift_assignment_draft.dart';
import 'package:rab_staff/features/venue_manager/venue_manager_provider.dart';

void main() {
  final start = DateTime.utc(2026, 10, 14, 21);
  final end = DateTime.utc(2026, 10, 15, 5);
  DirectoryUser staff(String id) => DirectoryUser.fromJson({
    'id': id,
    'firstName': 'Test',
    'lastName': id,
    'employmentStatus': 'active',
  });
  test('picker commits preserve custom times; deselection discards them', () {
    final draft = ShiftAssignmentDraft();
    final a = staff('a'), b = staff('b');
    draft.select({'a': a}, start, end);
    final custom = draft.assignments['a']!;
    custom.startsAt = DateTime.utc(2026, 10, 15);
    custom.customised = true;
    custom.breakMinutes = 60;
    draft.select({'a': a, 'b': b}, start, end);
    expect(draft.assignments['a'], same(custom));
    expect(custom.effectiveBreak(30), 60);
    expect(custom.toJson()['breakMinutes'], 60);
    expect(draft.assignments['b']!.startsAt, start);
    draft.select({'b': b}, start, end);
    draft.select({'a': a, 'b': b}, start, end);
    expect(draft.assignments['a']!.customised, isFalse);
    expect(draft.assignments['a']!.startsAt, start);
  });
  test('optional break inherits, zero overrides and excessive/negative breaks fail', () {
    final a = StaffAssignmentDraft(staff('a'), start, end);
    expect(a.effectiveBreak(30), 30);
    expect(a.toJson()['breakMinutes'], isNull);
    a.breakMinutes = 0;
    expect(a.effectiveBreak(30), 0);
    expect(a.valid(start, end, 30), isTrue);
    for (final value in [-1, 480, 500]) {
      a.breakMinutes = value;
      expect(a.valid(start, end, 30), isFalse);
    }
  });
  test('parent changes update defaults and preserve custom windows outside defaults', () {
    final draft = ShiftAssignmentDraft();
    draft.select({'a': staff('a'), 'b': staff('b')}, start, end);
    final a = draft.assignments['a']!;
    a.startsAt = DateTime.utc(2026, 10, 15);
    a.customised = true;
    final next = DateTime.utc(2026, 10, 15, 1);
    draft.parentChanged(next, end);
    expect(a.valid(next, end, 30), isTrue);
    expect(draft.assignments['b']!.startsAt, next);
    expect(a.toJson()['startsAt'], '2026-10-15T00:00:00.000Z');
  });
}
