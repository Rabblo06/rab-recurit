import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'report_ui.dart';
import 'review_staff_report_screen.dart';
import 'shift_report.dart';
import 'report_document_screen.dart';
import 'sign_off_sheet.dart';
import 'venue_manager_provider.dart';

/// Staff badge for one report row, from real persisted server state only. "Reviewed" (green) means the explicit
/// attendance review was saved (`attendanceReviewed`) — never a saved correction, an opened screen or a performance
/// rating:
///   finalised report → Finalised · still clocked in → Clocked in / On break · no-show → No-show · Reviewed or
///   No-show · Needs review · reviewed → Reviewed · clock-out missing → Needs review · corrected, unreviewed →
///   Corrected · Awaiting review · clocked out, unreviewed → Awaiting review · not clocked in yet → Waiting.
(String, ReportBadgeTone) staffReportBadge(
  ShiftReportStaffRow r, {
  required bool ended,
  bool finalised = false,
}) {
  if (finalised) return ('Finalised', ReportBadgeTone.neutral);
  if (r.isOpen) {
    return (
      r.attendanceStatus == 'on_break' ? 'On break' : 'Clocked in',
      ReportBadgeTone.info,
    );
  }
  if (r.isNoShow) {
    return r.attendanceReviewed
        ? ('No-show · Reviewed', ReportBadgeTone.reviewed)
        : ('No-show · Needs review', ReportBadgeTone.needsReview);
  }
  if (r.attendanceReviewed && r.clockOutAt != null) {
    return ('Reviewed', ReportBadgeTone.reviewed);
  }
  if (r.clockOutAt == null &&
      (r.attendanceStatus == 'missing_clock_out' || ended)) {
    return ('Needs review', ReportBadgeTone.needsReview);
  }
  if (r.clockInAt == null) return ('Waiting', ReportBadgeTone.waiting);
  if (r.clockOutAt != null) {
    return r.corrected
        ? ('Corrected · Awaiting review', ReportBadgeTone.awaiting)
        : ('Awaiting review', ReportBadgeTone.awaiting);
  }
  return ('Clocked in', ReportBadgeTone.info);
}

/// Whether the shift's scheduled end has passed, by SERVER time (the lifecycle status was computed against DB
/// `now()`); the device clock is only a fallback for a report without a lifecycle.
bool reportEnded(ShiftReportDetail report) {
  final status = report.lifecycle?.displayStatus;
  if (status == null) return !DateTime.now().isBefore(report.endsAt);
  return !const {
    'upcoming',
    'waiting_clock_in',
    'in_progress',
  }.contains(status);
}

/// The notice under the summary, chosen from the server lifecycle + real counts (never from mock values).
(String, String?)? reportNotice(ShiftReportDetail report) {
  final life = report.lifecycle;
  final missing = report.missingClockOut;
  final n = report.staff.length;
  switch (life?.displayStatus) {
    case 'upcoming':
    case 'waiting_clock_in':
      return (
        'Waiting staff to Clock-in',
        'Download the Time-sheet for staff to Clock-in',
      );
    case 'in_progress':
      return (
        'Shift in progress',
        '${report.clockedIn} of $n staff clocked in',
      );
    case 'waiting_clock_out':
      final still = report.staff
          .where(
            (s) =>
                s.attendanceStatus == 'clocked_in' ||
                s.attendanceStatus == 'on_break',
          )
          .length;
      return (
        'Waiting for staff to clock out',
        '$still ${still == 1 ? 'staff member is' : 'staff are'} still clocked in',
      );
    case 'needs_review':
      if (missing == 0) {
        final left = report.reviewsRemaining;
        return (
          '$left attendance ${left == 1 ? 'review' : 'reviews'} remaining',
          "Check each staff member's hours and mark them reviewed before finalising.",
        );
      }
      return (
        '$missing clock-out ${missing == 1 ? 'time needs' : 'times need'} checking',
        'Review staff hours before finalising this report.',
      );
    case 'action_expired':
      return life!.needsAttendanceReview && missing > 0
          ? (
              'Action expired · needs attendance review',
              '$missing clock-out ${missing == 1 ? 'time still needs' : 'times still need'} checking before this report can be finalised.',
            )
          : (
              'Action expired',
              'This shift ended more than 5 hours ago. Finalise and send the timesheet.',
            );
    case 'generating':
      return (
        'Generating the final timesheet',
        'The signed PDF is being prepared.',
      );
    case 'queued':
      return (
        'Queued for delivery',
        'The final timesheet will be emailed shortly.',
      );
    case 'delivery_failed':
      return (
        'Delivery failed',
        'The final timesheet email could not be delivered. Download the PDF from Time-sheet.',
      );
    case 'cancelled':
      return ('Shift cancelled', null);
  }
  return null;
}

String workedLabel(ShiftReportStaffRow r) {
  final m = r.workedMinutes;
  if (m != null) return m % 60 == 0 ? '${m ~/ 60}h' : '${m ~/ 60}h ${m % 60}m';
  if (r.assignmentStatus == 'no_show') return '—';
  // "Awaiting clock-out" only while the clock-out is genuinely missing; never after one was saved.
  return r.clockInAt == null || r.clockOutAt != null
      ? '—'
      : 'Awaiting clock-out';
}

class ShiftReportScreen extends StatefulWidget {
  const ShiftReportScreen({super.key, required this.shiftId});
  final String shiftId;

  @override
  State<ShiftReportScreen> createState() => _ShiftReportScreenState();
}

class _ShiftReportScreenState extends State<ShiftReportScreen> {
  ShiftReportDetail? _report;
  String? _error;
  bool _loading = true;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await context.read<VenueManagerProvider>().loadReport(
        widget.shiftId,
      );
      if (mounted) setState(() => _report = r);
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = e is ApiException
              ? e.message
              : 'Could not load this report.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  bool _finalising = false;

  /// One finalisation at a time: the button is busy while the sheet is open and until the report reloads.
  Future<void> _finalise(ShiftReportDetail report) async {
    if (_finalising) return;
    setState(() => _finalising = true);
    try {
      final sent = await showSignOffSheet(context, report);
      if (sent && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text(
              'Report finalised. The final timesheet is being generated.',
            ),
          ),
        );
        await _load();
      }
    } finally {
      if (mounted) setState(() => _finalising = false);
    }
  }

  Future<void> _push(Widget page) async {
    await Navigator.of(
      context,
    ).push(MaterialPageRoute<void>(builder: (_) => page));
    if (mounted) await _load();
  }

  @override
  Widget build(BuildContext context) {
    final report = _report;
    if (report == null) {
      return ReportPage(
        title: 'Shift report',
        body: _loading
            ? const Center(child: CircularProgressIndicator())
            : Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      ScheduleMessageCard(
                        title: _error ?? 'Could not load this report.',
                        kind: ScheduleMessageKind.error,
                      ),
                      const SizedBox(height: 12),
                      ReportButton(label: 'Retry', onPressed: _load),
                    ],
                  ),
                ),
              ),
      );
    }
    final canExport = context.select<VenueManagerProvider, bool>(
      (p) => p.allows('report.export'),
    );
    final ended = reportEnded(report);
    final notice = reportNotice(report);
    return ReportPage(
      title: 'Shift report',
      body: RefreshIndicator(
        onRefresh: _load,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.baseline,
              textBaseline: TextBaseline.alphabetic,
              children: [
                Expanded(
                  child: Text(
                    report.venueName,
                    style: const TextStyle(
                      fontSize: 26,
                      fontWeight: FontWeight.w700,
                      color: ReportTokens.ink,
                    ),
                  ),
                ),
                Text(
                  reportDate(report.startsAt),
                  style: const TextStyle(
                    fontSize: 15,
                    color: ReportTokens.muted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 16),
            ReportCard(
              child: Row(
                children: [
                  Expanded(
                    child: _summary(
                      reportTimeRange(report.startsAt, report.endsAt),
                      'Scheduled shift',
                    ),
                  ),
                  Expanded(
                    child: _summary(
                      '${report.staff.length} staff',
                      report.isFinalised ? 'Finalised' : 'To review',
                    ),
                  ),
                ],
              ),
            ),
            if (notice != null) ...[
              const SizedBox(height: 14),
              ReportNotice(title: notice.$1, message: notice.$2),
            ],
            const SizedBox(height: 22),
            Row(
              children: [
                const Expanded(
                  child: Text(
                    'Staff reports',
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w600,
                      color: ReportTokens.ink,
                    ),
                  ),
                ),
                Text(
                  '${report.reviewedCount} of ${report.staff.length} reviewed',
                  style: const TextStyle(
                    fontSize: 13,
                    color: ReportTokens.muted,
                  ),
                ),
              ],
            ),
            const SizedBox(height: 12),
            if (report.staff.isEmpty)
              const ScheduleMessageCard(
                title: 'No confirmed staff for this shift.',
              ),
            for (final row in report.staff)
              Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: _StaffCard(
                  row: row,
                  ended: ended,
                  finalised: report.isFinalised,
                  onReview: () =>
                      _push(ReviewStaffReportScreen(report: report, row: row)),
                ),
              ),
            if (report.signOff != null)
              Text(
                'Signed off as "${report.signOff!.name}"${report.signOff!.signedAt == null ? '' : ' on ${DateFormat('d MMM, HH:mm').format(report.signOff!.signedAt!.toLocal())}'}',
                style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
              ),
          ],
        ),
      ),
      bottom: ReportActionBar.forReport(
        actions: report.actions,
        blockedReason: report.finaliseBlockedReason,
        canExport: canExport,
        finalising: _finalising,
        onTimesheet: () => _push(ReportDocumentScreen(shiftId: report.shiftId)),
        onFinalise: () => _finalise(report),
      ),
    );
  }

  Widget _summary(String value, String label) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(
        value,
        style: const TextStyle(
          fontSize: 17,
          fontWeight: FontWeight.w700,
          color: ReportTokens.ink,
        ),
      ),
      const SizedBox(height: 2),
      Text(
        label,
        style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
      ),
    ],
  );
}

class _StaffCard extends StatelessWidget {
  const _StaffCard({
    required this.row,
    required this.ended,
    required this.finalised,
    required this.onReview,
  });
  final ShiftReportStaffRow row;
  final bool ended;
  final bool finalised;
  final VoidCallback onReview;

  @override
  Widget build(BuildContext context) {
    final (label, tone) = staffReportBadge(
      row,
      ended: ended,
      finalised: finalised,
    );
    final missingOut =
        ended &&
        row.clockInAt != null &&
        row.clockOutAt == null &&
        row.assignmentStatus != 'no_show';
    final scheduled = row.scheduledStart != null && row.scheduledEnd != null
        ? reportTimeRange(row.scheduledStart!, row.scheduledEnd!)
        : '—';
    return ReportCard(
      padding: const EdgeInsets.fromLTRB(18, 16, 18, 16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  row.staffName,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                    color: ReportTokens.ink,
                  ),
                ),
              ),
              ReportBadge(label, tone),
            ],
          ),
          const SizedBox(height: 12),
          ReportField('Scheduled', scheduled),
          ReportField(
            'Clock in',
            row.clockInAt == null
                ? '—'
                : DateFormat('HH:mm').format(row.clockInAt!.toLocal()),
          ),
          ReportField(
            'Clock out',
            row.clockOutAt != null
                ? DateFormat('HH:mm').format(row.clockOutAt!.toLocal())
                : (missingOut ? 'Missing' : '—'),
            valueColor: missingOut ? ReportTokens.missing : null,
          ),
          ReportField(
            'Break',
            '${row.breakMinutes ?? row.scheduledBreakMinutes} min${row.breakMinutes == null ? ' (scheduled)' : ''}',
          ),
          ReportField('Worked', workedLabel(row)),
          if (row.corrected)
            const ReportField('', 'Corrected', valueColor: ReportTokens.muted),
          if (row.attendanceReviewed)
            ReportField(
              'Reviewed by',
              [
                row.attendanceReviewedByName ?? 'Manager',
                if (row.attendanceReviewedAt != null)
                  DateFormat(
                    'd MMM, HH:mm',
                  ).format(row.attendanceReviewedAt!.toLocal()),
              ].join(' · '),
            ),
          const SizedBox(height: 8),
          ReportButton(
            key: Key('review-hours-${row.staffProfileId}'),
            label: row.attendanceReviewed || finalised
                ? 'View hours'
                : 'Review hours',
            onPressed: onReview,
          ),
        ],
      ),
    );
  }
}

/// The ONE footer of the Shift report, rendered from the server's `actions` (`report-actions.ts`); no time windows are
/// computed here. Time-sheet only before the start and after finalisation; Time-sheet + Finalise & send (equal widths)
/// once the shift has started, Finalise disabled until the server says the report is ready. Returns null (no footer)
/// before the pre-shift window.
class ReportActionBar extends StatelessWidget {
  const ReportActionBar._({
    required this.actions,
    required this.blockedReason,
    required this.canExport,
    required this.finalising,
    required this.onTimesheet,
    required this.onFinalise,
  });

  static Widget? forReport({
    required ReportActions? actions,
    String? blockedReason,
    required bool canExport,
    required bool finalising,
    required VoidCallback onTimesheet,
    required VoidCallback onFinalise,
  }) {
    if (actions == null) return null;
    final showFinalise = actions.showFinalise && canExport;
    if (!actions.showTimesheet && !showFinalise) return null;
    return ReportActionBar._(
      actions: actions,
      blockedReason: blockedReason,
      canExport: canExport,
      finalising: finalising,
      onTimesheet: onTimesheet,
      onFinalise: onFinalise,
    );
  }

  final ReportActions actions;

  /// Server-derived reason Finalise & send is disabled ("2 attendance reviews remaining"), shown above the buttons.
  final String? blockedReason;
  final bool canExport;
  final bool finalising;
  final VoidCallback onTimesheet;
  final VoidCallback onFinalise;

  @override
  Widget build(BuildContext context) {
    final showFinalise = actions.showFinalise && canExport;
    final timesheet = ReportButton(
      key: const Key('open-timesheet'),
      label: 'Time-sheet',
      onPressed: actions.showTimesheet ? onTimesheet : null,
    );
    final hint = showFinalise && !actions.canFinalise ? blockedReason : null;
    return ReportBottomBar(
      children: [
        if (hint != null)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: Text(
              hint,
              key: const Key('finalise-blocked-reason'),
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
            ),
          ),
        if (!showFinalise)
          timesheet
        else
          Row(
            children: [
              if (actions.showTimesheet) ...[
                Expanded(child: timesheet),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: ReportButton(
                  key: const Key('finalise-and-send'),
                  label: 'Finalise & send',
                  onPressed: actions.canFinalise && !finalising
                      ? onFinalise
                      : null,
                ),
              ),
            ],
          ),
      ],
    );
  }
}
