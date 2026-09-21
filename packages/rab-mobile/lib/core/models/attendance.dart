/// Mirrors `AttendanceSummary` in `packages/rab-server/src/modules/attendance/services/attendance.service.ts`.
/// `status` is the real `@rab/shared` `AttendanceStatus` value — never the
/// old `'active'`/`'completed'` pair — see [isOpen]/[hasEnded] below, the
/// one place this app maps status to "still clocked in" vs "done", so no
/// screen needs to hardcode the status string itself.
class AttendanceSummary {
  final String id;
  final String status;
  final DateTime clockInAt;
  final DateTime? clockOutAt;
  final int? workedMinutes;
  final int? earnedPence;
  final int? breakMinutes;
  final bool locationVerified;
  final String? clockOutMethod;
  final String shiftId;
  final DateTime startsAt;
  final DateTime endsAt;
  final String venueName;
  final String roleName;
  final String staffProfileId;
  final String staffName;

  AttendanceSummary({
    required this.id,
    required this.status,
    required this.clockInAt,
    this.clockOutAt,
    this.workedMinutes,
    this.earnedPence,
    this.breakMinutes,
    this.locationVerified = false,
    this.clockOutMethod,
    required this.shiftId,
    required this.startsAt,
    required this.endsAt,
    required this.venueName,
    required this.roleName,
    required this.staffProfileId,
    required this.staffName,
  });

  /// Still actively on shift — the only two states this app's own clock
  /// flow ever produces are `clocked_in`/`on_break` (no staff-facing break
  /// button ships in this app, but `on_break` is included for correctness
  /// in case a future change or a manager-side flow sets it).
  bool get isOpen => status == 'clocked_in' || status == 'on_break';

  /// No longer actively clocked in, regardless of whether a manager has
  /// since reviewed/approved it — a staff member's own history view should
  /// show a shift as "done" the moment they clock out, not wait for a
  /// back-office review step they can't see.
  bool get hasEnded => !isOpen && status != 'scheduled';

  factory AttendanceSummary.fromJson(Map<String, dynamic> json) {
    return AttendanceSummary(
      id: json['id'] as String,
      status: json['status'] as String,
      clockInAt: DateTime.parse(json['clockInAt'] as String),
      clockOutAt: json['clockOutAt'] == null ? null : DateTime.parse(json['clockOutAt'] as String),
      workedMinutes: json['workedMinutes'] as int?,
      earnedPence: json['earnedPence'] as int?,
      breakMinutes: json['breakMinutes'] as int?,
      locationVerified: json['locationVerified'] as bool? ?? false,
      clockOutMethod: json['clockOutMethod'] as String?,
      shiftId: json['shiftId'] as String,
      startsAt: DateTime.parse(json['startsAt'] as String),
      endsAt: DateTime.parse(json['endsAt'] as String),
      venueName: json['venueName'] as String,
      roleName: json['roleName'] as String,
      staffProfileId: json['staffProfileId'] as String,
      staffName: json['staffName'] as String,
    );
  }
}
