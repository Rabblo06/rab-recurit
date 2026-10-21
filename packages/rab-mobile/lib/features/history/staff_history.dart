import '../../core/models/attendance.dart';
import '../../core/models/offer.dart';

enum HistoryFilter { all, needsAttention, completed }

enum HistoryOutcome {
  /// Payroll approved; hours and pay are final.
  verified,

  /// Payroll was approved, but a correction or dispute has since been raised
  /// on the attendance record (`under_review` / `disputed`).
  needsAttention,
}

/// One History row. History is payroll-approved work only:
/// Clock out → timesheet → manager payroll approval → History.
/// A shift that has ended, been clocked out, or had its timesheet signed is
/// NOT history until the server reports its payroll as approved.
class StaffHistoryEntry {
  StaffHistoryEntry({
    required this.shiftId,
    required this.role,
    required this.venue,
    required this.startsAt,
    required this.endsAt,
    required this.outcome,
    required this.badge,
    required this.attendance,
    this.attentionMessage,
    this.venuePhotoFileId,
  });

  final String shiftId, role, venue, badge;
  final DateTime startsAt, endsAt;
  final HistoryOutcome outcome;
  final AttendanceSummary attendance;
  final String? attentionMessage;
  final String? venuePhotoFileId;

  bool get needsAttention => outcome == HistoryOutcome.needsAttention;

  bool matches(HistoryFilter filter) => switch (filter) {
    HistoryFilter.all => true,
    HistoryFilter.needsAttention => needsAttention,
    HistoryFilter.completed => !needsAttention,
  };
}

StaffHistoryEntry _fromApproved(AttendanceSummary a, OfferSummary? offer) {
  final (outcome, badge, message) = switch (a.status) {
    'under_review' => (
      HistoryOutcome.needsAttention,
      'Under review',
      'A correction to this approved shift is being reviewed.',
    ),
    'disputed' => (
      HistoryOutcome.needsAttention,
      'Disputed',
      'These approved hours are disputed. Contact your manager.',
    ),
    _ => (HistoryOutcome.verified, 'Completed', null),
  };
  return StaffHistoryEntry(
    shiftId: a.shiftId,
    role: a.roleName,
    venue: a.venueName,
    startsAt: a.startsAt,
    endsAt: a.endsAt,
    outcome: outcome,
    badge: badge,
    attendance: a,
    attentionMessage: message,
    venuePhotoFileId: a.venuePhotoFileId ?? offer?.venuePhotoFileId,
  );
}

/// Payroll-approved attendance only, newest first. [offers] only supplies a
/// venue photo; offers never create History rows.
List<StaffHistoryEntry> buildStaffHistory({
  required List<AttendanceSummary> history,
  required List<OfferSummary> offers,
}) {
  final offerByShift = {for (final o in offers) o.shiftId: o};
  final rows = [
    for (final a in history)
      if (a.payrollApproved && !a.isOpen)
        _fromApproved(a, offerByShift[a.shiftId]),
  ]..sort((a, b) => b.startsAt.compareTo(a.startsAt));
  return rows;
}

/// Payroll-approved minutes for shifts starting in the calendar month of
/// [now] (device local time).
int verifiedMinutesThisMonth(List<StaffHistoryEntry> rows, DateTime now) {
  final local = now.toLocal();
  return rows
      .where(
        (r) =>
            r.startsAt.toLocal().year == local.year &&
            r.startsAt.toLocal().month == local.month,
      )
      .fold(0, (sum, r) => sum + (r.attendance.workedMinutes ?? 0));
}
