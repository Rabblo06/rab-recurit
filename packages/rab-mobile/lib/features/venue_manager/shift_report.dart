/// Mirrors `ShiftReportStaffRow` in
/// `packages/rab-server/src/modules/attendance/services/shift-report.service.ts`
/// — one row per CONFIRMED/COMPLETED/NO_SHOW assignment on the shift, even
/// when the staff member never clocked in at all (`attendanceId == null`),
/// so a no-show is visible on the report rather than silently missing.
class ShiftReportStaffRow {
  ShiftReportStaffRow.fromJson(Map<String, dynamic> json)
    : staffProfileId = json['staffProfileId'] as String,
      staffName = json['staffName'] as String,
      roleName = json['roleName'] as String,
      assignmentStatus = json['assignmentStatus'] as String,
      attendanceId = json['attendanceId'] as String?,
      attendanceStatus = json['attendanceStatus'] as String?,
      clockInAt = json['clockInAt'] == null
          ? null
          : DateTime.parse(json['clockInAt'] as String),
      clockOutAt = json['clockOutAt'] == null
          ? null
          : DateTime.parse(json['clockOutAt'] as String),
      breakMinutes = json['breakMinutes'] as int?,
      scheduledBreakMinutes = json['scheduledBreakMinutes'] as int,
      workedMinutes = json['workedMinutes'] as int?,
      earnedPence = json['earnedPence'] as int?,
      locationVerified = json['locationVerified'] as bool? ?? false,
      clockOutMethod = json['clockOutMethod'] as String?,
      corrected = json['corrected'] as bool? ?? false;

  final String staffProfileId;
  final String staffName;
  final String roleName;
  final String assignmentStatus;
  final String? attendanceId;
  final String? attendanceStatus;
  final DateTime? clockInAt;
  final DateTime? clockOutAt;
  final int? breakMinutes;
  final int scheduledBreakMinutes;
  final int? workedMinutes;
  final int? earnedPence;
  final bool locationVerified;
  final String? clockOutMethod;
  final bool corrected;

  /// Real, backend-derived status → display label. Never a raw enum value
  /// or a UUID shown to the Venue Manager.
  String get statusLabel => switch (attendanceStatus) {
    null => 'Not clocked in',
    'clocked_in' => 'Clocked in',
    'on_break' => 'On break',
    'clocked_out' => 'Clocked out',
    'under_review' => 'Under review',
    'approved' => 'Approved',
    'missing_clock_out' => 'Missing clock-out',
    'late' => 'Late',
    'absent' => 'Absent',
    'disputed' => 'Disputed',
    _ => attendanceStatus!,
  };

  bool get canCorrect => attendanceId != null;
}

/// Mirrors `ShiftReportDetail` in the same file — the full per-shift Venue
/// Manager report: roster + attendance + break + earnings, one row per
/// confirmed staff member.
class ShiftReportDetail {
  ShiftReportDetail.fromJson(Map<String, dynamic> json)
    : shiftId = json['shiftId'] as String,
      venueName = json['venueName'] as String,
      roleName = json['roleName'] as String,
      startsAt = DateTime.parse(json['startsAt'] as String),
      endsAt = DateTime.parse(json['endsAt'] as String),
      reportStatus = json['reportStatus'] as String,
      finalisedAt = json['finalisedAt'] == null
          ? null
          : DateTime.parse(json['finalisedAt'] as String),
      staff = (json['staff'] as List)
          .map((s) => ShiftReportStaffRow.fromJson(s as Map<String, dynamic>))
          .toList();

  final String shiftId;
  final String venueName;
  final String roleName;
  final DateTime startsAt;
  final DateTime endsAt;
  final String reportStatus;
  final DateTime? finalisedAt;
  final List<ShiftReportStaffRow> staff;

  bool get isFinalised => reportStatus == 'finalised';

  /// Finalise is blocked server-side while anyone is still clocked in — this
  /// mirrors that check so the button can be disabled before the round trip
  /// rather than only failing after a tap.
  bool get canFinalise =>
      !isFinalised &&
      staff.isNotEmpty &&
      staff.every(
        (s) =>
            s.attendanceStatus != 'clocked_in' &&
            s.attendanceStatus != 'on_break',
      );
}
