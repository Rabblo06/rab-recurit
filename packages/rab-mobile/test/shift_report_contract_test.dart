import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/features/venue_manager/shift_report.dart';

void main() {
  for (final pence in <Object?>['25', 25, null, '2147483648']) {
    test('report accepts nullable integer pence from API: $pence', () {
      // Matches the fresh native-QA report's Postgres bigint response shape.
      final row = ShiftReportStaffRow.fromJson({
        'staffProfileId': 'qa-staff',
        'staffName': 'QA Staff',
        'roleName': 'Bartender',
        'assignmentStatus': 'completed',
        'attendanceId': 'qa-attendance',
        'attendanceStatus': 'clocked_out',
        'clockInAt': '2026-09-22T11:52:04Z',
        'clockOutAt': '2026-09-22T11:53:12Z',
        'breakMinutes': null,
        'scheduledBreakMinutes': 0,
        'workedMinutes': 1,
        'earnedPence': pence,
        'locationVerified': true,
      });
      expect(
        row.earnedPence,
        pence == null ? null : int.parse(pence.toString()),
      );
      expect(row.workedMinutes, 1);
      expect(row.statusLabel, 'Clocked out');
    });
  }
}
