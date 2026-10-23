import 'package:intl/intl.dart';

import '../../core/models/offer.dart';
import '../../core/theme/display_labels.dart';
import 'shift_report.dart';

/// One confirmed seat on ONE shift, for the Sent shift / Confirmed staff /
/// Event Details screens. Built from the server only:
///   * with `report.view` — the shift report's assignment rows
///     (confirmed / completed / no-show, with real attendance), the
///     authoritative source;
///   * without it — the shift's `manager_confirmed` offers, which carry no
///     attendance, so [row] is null and no attendance line is shown.
class ConfirmedStaffMember {
  ConfirmedStaffMember._({
    required this.staffProfileId,
    required this.name,
    required this.role,
    this.assignmentStatus,
    this.row,
    this.scheduledStart,
    this.scheduledEnd,
  });

  factory ConfirmedStaffMember.fromReport(ShiftReportStaffRow row) =>
      ConfirmedStaffMember._(
        staffProfileId: row.staffProfileId,
        name: row.staffName,
        role: displayRoleName(row.roleName),
        assignmentStatus: row.assignmentStatus,
        row: row,
        scheduledStart: row.scheduledStart,
        scheduledEnd: row.scheduledEnd,
      );

  factory ConfirmedStaffMember.fromOffer(OfferSummary offer) =>
      ConfirmedStaffMember._(
        staffProfileId: offer.staffProfileId,
        name: offer.staffName,
        role: displayRoleName(offer.roleName),
        scheduledStart: offer.startsAt,
        scheduledEnd: offer.endsAt,
      );

  final String staffProfileId, name, role;

  /// Assignment status from the report (`confirmed` | `completed` |
  /// `no_show`); null when only the offer is known.
  final String? assignmentStatus;

  /// The seat's real report row (attendance, review); null without
  /// `report.view`.
  final ShiftReportStaffRow? row;
  final DateTime? scheduledStart, scheduledEnd;

  bool get isNoShow => assignmentStatus == 'no_show';

  /// Offer-process badge: the booking itself, never attendance or payroll.
  /// A completed assignment was a confirmed booking. A worker-flagged
  /// no-show is provisional until the manager confirms it.
  String get bookingLabel => !isNoShow
      ? 'Confirmed'
      : row?.noShowConfirmed == true
      ? 'No-show'
      : 'Attendance missing';
}

/// The confirmed seats of one shift plus, when permitted, its report.
class ShiftRoster {
  const ShiftRoster({required this.members, this.report});
  final List<ConfirmedStaffMember> members;
  final ShiftReportDetail? report;

  /// Seats whose booking stands (confirmed or completed) — no-shows are
  /// listed but not counted as confirmed.
  int get confirmedCount => members.where((m) => !m.isNoShow).length;
  bool get hasAttendance => report != null;

  /// Builds the roster from the shift's offers (no attendance). Latest
  /// confirmed offer per staff member; other shifts' offers never leak in.
  factory ShiftRoster.fromOffers(String shiftId, List<OfferSummary> offers) {
    final seen = <String>{};
    final members = <ConfirmedStaffMember>[];
    for (final o in offers) {
      if (o.shiftId != shiftId || o.status != 'manager_confirmed') continue;
      if (seen.add(o.staffProfileId)) {
        members.add(ConfirmedStaffMember.fromOffer(o));
      }
    }
    members.sort((a, b) => a.name.compareTo(b.name));
    return ShiftRoster(members: members);
  }

  factory ShiftRoster.fromReport(ShiftReportDetail report) => ShiftRoster(
    members: report.staff.map(ConfirmedStaffMember.fromReport).toList(),
    report: report,
  );
}

String _hm(DateTime d) => DateFormat('HH:mm').format(d.toLocal());

/// The attendance line on a Confirmed staff card, from real report data
/// only. Never "not recorded" when an attendance record exists. Returns null
/// when attendance is unknown (no report row), so callers omit the line.
String? attendanceLine(ShiftReportStaffRow? r) {
  if (r == null) return null;
  final inAt = r.clockInAt, outAt = r.clockOutAt;
  if (r.isNoShow) {
    // Provisional until the manager confirms; missing attendance is not a
    // no-show.
    return r.noShowConfirmed
        ? 'No-show confirmed'
        : 'Attendance missing · Needs review';
  }
  if (r.isOpen) {
    final since = inAt == null ? '' : ' ${_hm(inAt)}';
    return r.attendanceStatus == 'on_break'
        ? 'On break · clocked in$since'
        : 'Clocked in$since';
  }
  if (outAt != null) {
    final range = inAt == null ? _hm(outAt) : '${_hm(inAt)}–${_hm(outAt)}';
    return r.attendanceReviewed
        ? 'Reviewed · $range'
        : 'Clocked out ${_hm(outAt)} · Awaiting review';
  }
  if (inAt != null) return 'Clocked in ${_hm(inAt)} · Clock-out missing';
  if (r.attendanceId == null) return 'Attendance not recorded';
  // A record exists without times (e.g. marked absent): its own label.
  return r.statusLabel;
}

/// Settles [future] into (value, error) right away, so a failure that lands
/// while the caller is still awaiting something else is never unhandled.
Future<(T?, Object?)> settle<T>(Future<T> future) =>
    future.then((v) => (v, null), onError: (Object e) => (null, e));
