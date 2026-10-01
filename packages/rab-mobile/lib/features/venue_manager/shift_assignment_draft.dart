import 'venue_manager_provider.dart';

class StaffAssignmentDraft {
  StaffAssignmentDraft(
    this.staff,
    this.startsAt,
    this.endsAt, {
    this.customised = false,
    this.breakMinutes,
  });
  final DirectoryUser staff;
  DateTime startsAt, endsAt;
  bool customised;
  int? breakMinutes;
  int effectiveBreak(int defaultBreak) => breakMinutes ?? defaultBreak;
  bool valid(DateTime parentStart, DateTime parentEnd, int defaultBreak) =>
      startsAt.isBefore(endsAt) &&
      effectiveBreak(defaultBreak) >= 0 &&
      effectiveBreak(defaultBreak) < endsAt.difference(startsAt).inMinutes;
  Map<String, dynamic> toJson() => {
    'staffProfileId': staff.id,
    'breakMinutes': breakMinutes,
    'startsAt': startsAt.toUtc().toIso8601String(),
    'endsAt': endsAt.toUtc().toIso8601String(),
  };
}

/// One committed selection; the picker edits its own temporary copy.
class ShiftAssignmentDraft {
  final Map<String, StaffAssignmentDraft> assignments = {};
  void select(Map<String, DirectoryUser> staff, DateTime start, DateTime end) {
    assignments.removeWhere((id, _) => !staff.containsKey(id));
    for (final entry in staff.entries) {
      assignments.putIfAbsent(
        entry.key,
        () => StaffAssignmentDraft(entry.value, start, end),
      );
    }
  }

  void parentChanged(DateTime start, DateTime end) {
    for (final assignment in assignments.values) {
      if (!assignment.customised) {
        assignment.startsAt = start;
        assignment.endsAt = end;
      }
    }
  }

  Map<String, DirectoryUser> get selected =>
      assignments.map((id, a) => MapEntry(id, a.staff));
}
