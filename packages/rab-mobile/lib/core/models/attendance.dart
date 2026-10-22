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

  /// Venue profile photo (`GET /files/:id`), when the venue has one.
  final String? venuePhotoFileId;

  /// Payroll state of this shift (`@rab/shared` `PayrollRecordStatus`), or
  /// null while no payroll record exists. Only the server sets it.
  final String? payrollStatus;

  /// Pay the authorised manager approved for this shift, in pence. Only
  /// present once payroll is approved; never an estimate.
  final int? payrollApprovedPence;

  /// How the clock-in was made: `staff` | `manager_on_behalf` |
  /// `manager_correction`; null for rows recorded before it existed.
  final String? clockInMethod;

  /// This booking needs a Check In before Clock In (false for bookings made
  /// before Check In shipped, and from servers that predate the field).
  final bool checkInRequired;

  /// Server time of the booking's Check In, or null.
  final DateTime? checkedInAt;

  /// `staff` | `qr` | null.
  final String? checkInSource;

  /// Payroll has been approved (it may since have moved on to processing or
  /// paid). Pending, rejected and corrected records are not approved.
  bool get payrollApproved =>
      const {'approved', 'processing', 'paid'}.contains(payrollStatus);

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
    this.venuePhotoFileId,
    this.payrollStatus,
    this.payrollApprovedPence,
    this.clockInMethod,
    this.checkInRequired = false,
    this.checkedInAt,
    this.checkInSource,
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
      clockOutAt: json['clockOutAt'] == null
          ? null
          : DateTime.parse(json['clockOutAt'] as String),
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
      venuePhotoFileId: json['venuePhotoFileId'] as String?,
      payrollStatus: json['payrollStatus'] as String?,
      payrollApprovedPence: json['payrollApprovedPence'] as int?,
      clockInMethod: json['clockInMethod'] as String?,
      checkInRequired: json['checkInRequired'] as bool? ?? false,
      checkedInAt: json['checkedInAt'] == null
          ? null
          : DateTime.parse(json['checkedInAt'] as String),
      checkInSource: json['checkInSource'] as String?,
    );
  }
}

/// Mirrors `CheckInState` in `attendance.service.ts` (POST
/// /attendance/check-in, GET /attendance/me/shift/:shiftId/check-in). Check
/// In is arrival evidence only — never worked time. Every instant here is the
/// server's.
class CheckInState {
  CheckInState.fromJson(Map<String, dynamic> json)
    : shiftId = json['shiftId'] as String,
      checkInRequired = json['checkInRequired'] as bool? ?? false,
      checkedInAt = _date(json['checkedInAt']),
      checkInSource = json['checkInSource'] as String?,
      locationVerified = json['locationVerified'] as bool? ?? false,
      distanceM = (json['distanceM'] as num?)?.toDouble(),
      accuracyM = (json['accuracyM'] as num?)?.toDouble(),
      geofenceEnforced = json['geofenceEnforced'] as bool? ?? false,
      opensAt = _date((json['window'] as Map?)?['opensAt']),
      closesAt = _date((json['window'] as Map?)?['closesAt']),
      clockedIn = json['clockedIn'] as bool? ?? false,
      alreadyCheckedIn = json['alreadyCheckedIn'] as bool? ?? false,
      serverNow = _date(json['serverNow']);

  final String shiftId;
  final bool checkInRequired;
  final DateTime? checkedInAt;
  final String? checkInSource;
  final bool locationVerified;
  final double? distanceM, accuracyM;

  /// The venue needs location evidence (lat, lng, accuracyM, capturedAt) for
  /// Check In, Clock In and Clock Out. When false the app never asks for
  /// location at all.
  final bool geofenceEnforced;

  /// The Check In / Clock In window (server-derived).
  final DateTime? opensAt, closesAt;
  final bool clockedIn, alreadyCheckedIn;
  final DateTime? serverNow;

  bool get checkedIn => checkedInAt != null;
}

/// `GET /attendance/me/active` `locationEvidence`: what a fix must satisfy at
/// a geofence-enforcing venue. Display/pre-check only; the server decides.
class LocationEvidenceLimits {
  const LocationEvidenceLimits({
    required this.maxAccuracyM,
    required this.maxAgeSeconds,
    required this.maxFutureSkewSeconds,
  });
  static LocationEvidenceLimits? maybe(Object? json) => json is Map
      ? LocationEvidenceLimits(
          maxAccuracyM: (json['maxAccuracyM'] as num).toDouble(),
          maxAgeSeconds: (json['maxAgeSeconds'] as num).toInt(),
          maxFutureSkewSeconds: (json['maxFutureSkewSeconds'] as num).toInt(),
        )
      : null;
  final double maxAccuracyM;
  final int maxAgeSeconds, maxFutureSkewSeconds;
}

DateTime? _date(Object? value) =>
    value is String ? DateTime.tryParse(value) : null;
