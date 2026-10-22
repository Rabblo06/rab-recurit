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
      scheduledStart = DateTime.tryParse(
        json['scheduledStart'] as String? ?? '',
      ),
      scheduledEnd = DateTime.tryParse(json['scheduledEnd'] as String? ?? ''),
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
      // Postgres bigint is serialized as a decimal string by the report API.
      earnedPence = json['earnedPence'] == null
          ? null
          : int.parse(json['earnedPence'].toString()),
      locationVerified = json['locationVerified'] as bool? ?? false,
      clockOutMethod = json['clockOutMethod'] as String?,
      corrected = json['corrected'] as bool? ?? false,
      performanceReviewed = json['performanceReviewed'] as bool? ?? false,
      attendanceReviewed = json['attendanceReviewed'] as bool? ?? false,
      attendanceReviewedAt = json['attendanceReviewedAt'] == null
          ? null
          : DateTime.parse(json['attendanceReviewedAt'] as String),
      attendanceReviewedByName = json['attendanceReviewedByName'] as String?,
      manuallyEntered = json['manuallyEntered'] as bool? ?? false,
      attendanceVersion = json['attendanceVersion'] as String?,
      // Older servers do not send it: a no-show seat whose review is complete is the confirmed one.
      noShowConfirmed =
          json['noShowConfirmed'] as bool? ??
          (json['assignmentStatus'] == 'no_show' &&
              (json['attendanceReviewed'] as bool? ?? false)),
      noShowConfirmableAt = DateTime.tryParse(
        json['noShowConfirmableAt'] as String? ?? '',
      ),
      checkInRequired = json['checkInRequired'] as bool? ?? false,
      checkedInAt = DateTime.tryParse(json['checkedInAt'] as String? ?? ''),
      checkInSource = json['checkInSource'] as String?,
      checkInLocationVerified =
          json['checkInLocationVerified'] as bool? ?? false,
      clockInMethod = json['clockInMethod'] as String?,
      clockInByName = json['clockInByName'] as String?,
      clockInReason = json['clockInReason'] as String?,
      clockOutByName = json['clockOutByName'] as String?,
      clockOutReason = json['clockOutReason'] as String?;

  final String staffProfileId;
  final String staffName;
  final String roleName;
  final DateTime? scheduledStart, scheduledEnd;
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

  /// A per-shift staff PERFORMANCE rating has been saved (server `shift_staff_review`). Optional; never the
  /// finalisation gate.
  final bool performanceReviewed;

  /// The manager completed this seat's ATTENDANCE review (server `shift_assignment.attendance_reviewed_at`). Set only
  /// by the explicit review action and cleared by any later correction — opening a screen or saving a correction never
  /// sets it. This is what "Reviewed" means and what gates Finalise & send.
  final bool attendanceReviewed;
  final DateTime? attendanceReviewedAt;
  final String? attendanceReviewedByName;

  /// The attendance was entered by a manager (the staff member never clocked in with the app).
  final bool manuallyEntered;

  /// Optimistic-concurrency token sent back with "Record attendance" (`expectedVersion`); null without attendance.
  final String? attendanceVersion;

  /// A MANAGER-confirmed no-show (owner rule 2026-10-21). `assignmentStatus == 'no_show'` alone is only the worker's
  /// provisional mark: the seat still needs "Record attendance" or "Confirm no-show".
  final bool noShowConfirmed;

  /// Earliest server time a no-show can be confirmed (scheduled start + the monitor's grace).
  final DateTime? noShowConfirmableAt;

  /// The booking needs the staff member's own Check In before Clock In (false for bookings made before Check In).
  final bool checkInRequired;

  /// Server time of the staff member's Check In (arrival evidence, not worked time), or null.
  final DateTime? checkedInAt;

  /// `staff` | `qr` | null.
  final String? checkInSource;

  /// The Check In passed the venue's geofence (only meaningful where the venue enforces it).
  final bool checkInLocationVerified;

  /// `staff` | `manager_on_behalf` | `manager_correction` | null (legacy).
  final String? clockInMethod;

  /// The manager who clocked the staff member in / out on their behalf, with the stated reason.
  final String? clockInByName, clockInReason, clockOutByName, clockOutReason;

  bool get checkedIn => checkedInAt != null;

  /// No attendance recorded and no confirmed no-show: the manager must record attendance or confirm the no-show.
  bool get attendanceMissing => attendanceId == null && !noShowConfirmed;

  bool get isOpen =>
      attendanceStatus == 'clocked_in' || attendanceStatus == 'on_break';
  bool get isNoShow => assignmentStatus == 'no_show';

  /// Attendance is resolved: a clock-out exists (worked or corrected) or the seat is a recorded no-show.
  bool get attendanceResolved => !isOpen && (isNoShow || clockOutAt != null);

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
          .toList(),
      ready = json['ready'] as bool? ?? false,
      finalisable = json['finalisable'] as bool? ?? false,
      reviewsRemaining = (json['reviewsRemaining'] as num?)?.toInt() ?? 0,
      lifecycle = json['lifecycle'] == null
          ? null
          : ReportLifecycle.fromJson(json['lifecycle'] as Map<String, dynamic>),
      preShiftFile = ReportFileRef.maybe(json['preShiftFile']),
      finalFile = ReportFileRef.maybe(json['finalFile']),
      qrWindow = json['qrWindow'] == null
          ? null
          : QrWindow.fromJson(json['qrWindow'] as Map<String, dynamic>),
      signOff = json['signOff'] == null
          ? null
          : ReportSignOff.fromJson(json['signOff'] as Map<String, dynamic>),
      actions = json['actions'] == null
          ? null
          : ReportActions.fromJson(json['actions'] as Map<String, dynamic>),
      serverNow = DateTime.tryParse(json['serverNow'] as String? ?? ''),
      attendancePolicy = AttendancePolicy.maybe(json['attendancePolicy']);

  final String shiftId;
  final String venueName;
  final String roleName;
  final DateTime startsAt;
  final DateTime endsAt;
  final String reportStatus;
  final DateTime? finalisedAt;
  final List<ShiftReportStaffRow> staff;

  /// Server readiness (`isReportReady`): every seat clocked out or a no-show, nobody still clocked in.
  final bool ready;

  /// Server `isReportFinalisable`: attendance resolved AND every seat's attendance reviewed (and not finalised).
  final bool finalisable;

  /// Seats whose attendance review is still outstanding (server count).
  final int reviewsRemaining;
  final ReportLifecycle? lifecycle;
  final ReportFileRef? preShiftFile;
  final ReportFileRef? finalFile;
  final QrWindow? qrWindow;
  final ReportSignOff? signOff;

  /// Footer + Time-sheet document, decided by the server from DB time (`report-actions.ts`). The app only renders it.
  final ReportActions? actions;

  /// The server's clock when this report was read (DB time); null from servers that predate it.
  final DateTime? serverNow;

  /// On-behalf punch rules for this venue (display hints; the server enforces them). Null from older servers.
  final AttendancePolicy? attendancePolicy;

  /// Attendance reviews completed (persisted) — the "N of M reviewed" figure.
  int get reviewedCount => staff.where((s) => s.attendanceReviewed).length;

  /// Seats with no clock-out and no no-show outcome (the same rule as server readiness).
  int get missingClockOut => staff
      .where((s) => s.assignmentStatus != 'no_show' && s.clockOutAt == null)
      .length;
  int get clockedIn => staff.where((s) => s.clockInAt != null).length;
  int get clockedOut => staff.where((s) => s.clockOutAt != null).length;

  bool get isFinalised => reportStatus == 'finalised';

  int get stillClockedIn => staff.where((s) => s.isOpen).length;

  /// The server's finalisation gate (`finalisable`): the button is disabled before the round trip, and the server
  /// still refuses (409) if anything changed in between.
  bool get canFinalise => !isFinalised && finalisable;

  /// Why Finalise & send is not available yet, from server data, most blocking first. Null when finalisable/finalised.
  String? get finaliseBlockedReason {
    if (isFinalised || finalisable) return null;
    if (staff.isEmpty) return 'No confirmed staff on this shift';
    final open = stillClockedIn;
    if (open > 0) {
      return '$open ${open == 1 ? 'staff member is' : 'staff are'} still clocked in';
    }
    final missing = staff
        .where(
          (s) => !s.isNoShow && s.clockInAt != null && s.clockOutAt == null,
        )
        .length;
    if (missing > 0) {
      return '$missing clock-out ${missing == 1 ? 'time' : 'times'} missing';
    }
    final notIn = staff
        .where((s) => !s.isNoShow && s.attendanceId == null)
        .length;
    if (notIn > 0) {
      return '$notIn ${notIn == 1 ? 'staff member has' : 'staff have'} no attendance yet';
    }
    if (reviewsRemaining > 0) {
      return '$reviewsRemaining attendance ${reviewsRemaining == 1 ? 'review' : 'reviews'} remaining';
    }
    return null;
  }
}

/// Mirrors the report's `attendancePolicy`: the venue enforces its geofence → clock-in on behalf needs a
/// location-verified Check In and clock-out on behalf is unavailable.
class AttendancePolicy {
  const AttendancePolicy({
    required this.geofenceEnforced,
    required this.onBehalfClockOutAllowed,
    required this.onBehalfReasonMinWords,
  });
  static AttendancePolicy? maybe(Object? json) => json is Map
      ? AttendancePolicy(
          geofenceEnforced: json['geofenceEnforced'] as bool? ?? false,
          onBehalfClockOutAllowed:
              json['onBehalfClockOutAllowed'] as bool? ?? false,
          onBehalfReasonMinWords:
              (json['onBehalfReasonMinWords'] as num?)?.toInt() ?? 10,
        )
      : null;
  final bool geofenceEnforced;
  final bool onBehalfClockOutAllowed;
  final int onBehalfReasonMinWords;
}

/// Words that carry a letter or digit — the same count the server applies to on-behalf reasons ("- - -" is not a
/// reason). Display/enablement only; the server re-checks.
int reasonWordCount(String text) => text
    .trim()
    .split(RegExp(r'\s+'))
    .where((w) => RegExp(r'[\p{L}\p{N}]', unicode: true).hasMatch(w))
    .length;

/// Mirrors `ReportLifecycle` (server `report-lifecycle.ts`): the five-hour display policy, computed against DB time.
class ReportLifecycle {
  ReportLifecycle.fromJson(Map<String, dynamic> json)
    : displayStatus = json['displayStatus'] as String,
      displayLabel = json['displayLabel'] as String,
      actionExpiresAt = DateTime.parse(json['actionExpiresAt'] as String),
      actionExpired = json['actionExpired'] as bool? ?? false,
      needsAttendanceReview = json['needsAttendanceReview'] as bool? ?? false,
      needsAttention = json['needsAttention'] as bool? ?? false,
      deliveryState = json['deliveryState'] as String? ?? 'not_finalised',
      sentAt = json['sentAt'] == null
          ? null
          : DateTime.parse(json['sentAt'] as String),
      historyAt = json['historyAt'] == null
          ? null
          : DateTime.parse(json['historyAt'] as String);

  final String displayStatus;
  final String displayLabel;
  final DateTime actionExpiresAt;
  final bool actionExpired;
  final bool needsAttendanceReview;
  final bool needsAttention;

  /// `not_finalised` | `generating` | `queued` | `sent` | `failed` | `no_recipients` — from the email outbox.
  final String deliveryState;
  final DateTime? sentAt;
  final DateTime? historyAt;
}

/// One row of `GET /attendance/report/shifts?bucket=current|history`.
class ReportSummary {
  ReportSummary.fromJson(Map<String, dynamic> json)
    : shiftId = json['shiftId'] as String,
      venueName = json['venueName'] as String,
      roleName = json['roleName'] as String,
      startsAt = DateTime.parse(json['startsAt'] as String),
      endsAt = DateTime.parse(json['endsAt'] as String),
      shiftStatus = json['shiftStatus'] as String,
      requiredCount = (json['requiredCount'] as num).toInt(),
      filledCount = (json['filledCount'] as num).toInt(),
      staffCount = (json['staffCount'] as num).toInt(),
      clockedOut = (json['clockedOut'] as num).toInt(),
      noShows = (json['noShows'] as num).toInt(),
      reportStatus = json['reportStatus'] as String,
      lifecycle = ReportLifecycle.fromJson(
        json['lifecycle'] as Map<String, dynamic>,
      );

  final String shiftId, venueName, roleName, shiftStatus, reportStatus;
  final DateTime startsAt, endsAt;
  final int requiredCount, filledCount, staffCount, clockedOut, noShows;
  final ReportLifecycle lifecycle;
  int get open => (requiredCount - filledCount).clamp(0, requiredCount);
}

class ReportFileRef {
  ReportFileRef(this.fileId, this.filename);
  static ReportFileRef? maybe(Object? json) => json is Map
      ? ReportFileRef(json['fileId'] as String, json['filename'] as String)
      : null;
  final String fileId;
  final String filename;
}

/// The QR clock-in/out window the server signs into the Shift QR (display only).
class QrWindow {
  QrWindow.fromJson(Map<String, dynamic> json)
    : opensAt = DateTime.parse(json['opensAt'] as String),
      closesAt = DateTime.parse(json['closesAt'] as String),
      state = json['state'] as String;
  final DateTime opensAt, closesAt;

  /// `not_open` | `open` | `closed`
  final String state;
}

class ReportSignOff {
  ReportSignOff.fromJson(Map<String, dynamic> json)
    : name = json['name'] as String,
      breakConfirmed = json['breakConfirmed'] as bool? ?? false,
      signedBy = json['signedBy'] as String?,
      signedAt = json['signedAt'] == null
          ? null
          : DateTime.parse(json['signedAt'] as String);
  final String name;
  final bool breakConfirmed;
  final String? signedBy;
  final DateTime? signedAt;
}

/// The five Staff review categories, in display order, with their wire names.
const staffReviewCategories = <(String, String)>[
  ('grooming', 'Grooming'),
  ('attitude', 'Attitude'),
  ('skills', 'Skills'),
  ('attendance', 'Attendance'),
  ('timeKeeping', 'Time keeping'),
];

class StaffReview {
  StaffReview.fromJson(Map<String, dynamic> json)
    : ratings = {
        for (final (key, _) in staffReviewCategories)
          key: (json[key] as num).toInt(),
      },
      feedback = json['feedback'] as String?,
      reviewerName = json['reviewerName'] as String?,
      updatedAt = json['updatedAt'] == null
          ? null
          : DateTime.parse(json['updatedAt'] as String);
  final Map<String, int> ratings;
  final String? feedback;
  final String? reviewerName;
  final DateTime? updatedAt;
}

/// One openable report document (`/files/:id/download`, authorised by ReportFilePolicy).
class ReportDocument {
  ReportDocument.fromJson(Map<String, dynamic> json)
    : kind = json['kind'] as String,
      fileId = json['fileId'] as String,
      filename = json['filename'] as String;
  static ReportDocument? maybe(Object? json) =>
      json is Map<String, dynamic> ? ReportDocument.fromJson(json) : null;

  /// `pre_shift` (shift attendance sheet with the Shift QR) or `final` (final timesheet).
  final String kind;
  final String fileId;
  final String filename;
  bool get isFinal => kind == 'final';
}

/// Mirrors server `ReportActions`: `stage` is scheduled | pre_shift | started | finalised; `timesheet` is
/// hidden | preparing | available; `finalise` is hidden | disabled | enabled.
class ReportActions {
  ReportActions.fromJson(Map<String, dynamic> json)
    : stage = json['stage'] as String,
      timesheetAvailableAt = DateTime.parse(
        json['timesheetAvailableAt'] as String,
      ),
      timesheet = json['timesheet'] as String,
      finalise = json['finalise'] as String,
      document = ReportDocument.maybe(json['document']),
      preShiftDocument = ReportDocument.maybe(json['preShiftDocument']),
      finalDocumentPending = json['finalDocumentPending'] as bool? ?? false;

  final String stage;
  final DateTime timesheetAvailableAt;
  final String timesheet;
  final String finalise;
  final ReportDocument? document;
  final ReportDocument? preShiftDocument;
  final bool finalDocumentPending;

  bool get showTimesheet => timesheet != 'hidden';
  bool get showFinalise => finalise != 'hidden';
  bool get canFinalise => finalise == 'enabled';
}
