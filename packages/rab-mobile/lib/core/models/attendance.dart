/// Mirrors `AttendanceSummary` in `packages/rab-server/src/modules/attendance/services/attendance.service.ts`.
class AttendanceSummary {
  final String id;
  final String status; // 'active' | 'completed'
  final DateTime clockInAt;
  final DateTime? clockOutAt;
  final int? workedMinutes;
  final int? earnedPence;
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
    required this.shiftId,
    required this.startsAt,
    required this.endsAt,
    required this.venueName,
    required this.roleName,
    required this.staffProfileId,
    required this.staffName,
  });

  factory AttendanceSummary.fromJson(Map<String, dynamic> json) {
    return AttendanceSummary(
      id: json['id'] as String,
      status: json['status'] as String,
      clockInAt: DateTime.parse(json['clockInAt'] as String),
      clockOutAt: json['clockOutAt'] == null ? null : DateTime.parse(json['clockOutAt'] as String),
      workedMinutes: json['workedMinutes'] as int?,
      earnedPence: json['earnedPence'] as int?,
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
