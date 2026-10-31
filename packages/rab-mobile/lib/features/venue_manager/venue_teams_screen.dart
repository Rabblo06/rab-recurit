import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/api/attendance_messages.dart';
import '../../core/polling/poll_scheduler.dart';
import '../../core/polling/stale_refresh_notice.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/schedule_record_card.dart';
import '../../core/widgets/shift_countdown_panel.dart';
import 'confirmed_staff.dart';
import 'shift_report.dart';
import 'shift_staff_screens.dart';
import 'venue_manager_provider.dart';

/// Venue Manager "Teams" for one shift (owner reference: Event Details →
/// Clock-In/Out). The Team Leader is the signed-in Venue Manager; "Your team"
/// is the shift report's seats with each one's real Check In / attendance
/// state. With `attendance.edit` a row offers Clock-In (only after the staff
/// member's own Check In) or Clock-out ON BEHALF, each with a ≥ 10-word
/// reason. No success toast: the row itself shows the server's new state.
class VenueTeamsScreen extends StatefulWidget {
  const VenueTeamsScreen({super.key, required this.event, this.leaderName});
  final VenueEvent event;

  /// The signed-in Venue Manager's name (Team Leader row).
  final String? leaderName;

  @override
  State<VenueTeamsScreen> createState() => _VenueTeamsScreenState();
}

String _hm(DateTime d) => DateFormat('HH:mm').format(d.toLocal());

String _firstName(String name) {
  final parts = name.trim().split(RegExp(r'\s+'));
  return parts.isEmpty || parts.first.isEmpty ? name : parts.first;
}

enum TeamChipTone { ok, warning, danger, neutral }

/// One seat's state chip, from the report row only (never guessed).
(String, TeamChipTone) teamRowState(ShiftReportStaffRow r) {
  if (r.isNoShow) {
    return r.noShowConfirmed
        ? ('No-show', TeamChipTone.danger)
        : ('Attendance missing', TeamChipTone.warning);
  }
  if (r.clockOutAt != null) {
    return ('Clocked out ${_hm(r.clockOutAt!)}', TeamChipTone.neutral);
  }
  if (r.isOpen) {
    return r.attendanceStatus == 'on_break'
        ? ('On break', TeamChipTone.ok)
        : (
            r.clockInAt == null
                ? 'Clocked in'
                : 'Clocked in ${_hm(r.clockInAt!)}',
            TeamChipTone.ok,
          );
  }
  if (r.attendanceId != null) return (r.statusLabel, TeamChipTone.neutral);
  if (r.checkedInAt != null) {
    return ('Checked in ${_hm(r.checkedInAt!)}', TeamChipTone.ok);
  }
  return ('Not checked in', TeamChipTone.warning);
}

enum TeamRowAction { clockIn, clockOut }

/// The on-behalf action a row offers. Needs `attendance.edit`; never on a
/// finalised report, a no-show seat or a seat that already has attendance.
TeamRowAction? teamRowAction(
  ShiftReportStaffRow r, {
  required bool canEdit,
  required bool finalised,
}) {
  if (!canEdit || finalised) return null;
  if (r.isOpen) return TeamRowAction.clockOut;
  if (r.attendanceId == null && !r.isNoShow) return TeamRowAction.clockIn;
  return null;
}

class _VenueTeamsScreenState extends State<VenueTeamsScreen> {
  ShiftReportDetail? _report;
  Object? _error;
  bool _loading = true;

  /// A silent refresh failed while rows were on screen: they stay, with a
  /// non-blocking notice, until the next successful read.
  bool _stale = false;
  int _generation = 0;

  /// Staff check in on their own phones: the rows are re-read every
  /// [pollInterval] ±20 % while this screen is visible and the app is in the
  /// foreground, plus once on resume ([PollScheduler]).
  static const pollInterval = Duration(seconds: 30);
  late final PollScheduler _poll;

  /// Server clock (report `serverNow`) + time since it was read.
  DateTime? _anchor;
  final Stopwatch _sinceAnchor = Stopwatch();
  DateTime? get _now => _anchor?.add(_sinceAnchor.elapsed);

  @override
  void initState() {
    super.initState();
    _load();
    _poll = PollScheduler(
      interval: pollInterval,
      identity: () =>
          context.read<VenueManagerProvider>().api.sessionGeneration,
      task: (trigger) async {
        final error = await _load(
          silent: true,
          background: trigger.isBackground,
        );
        if (error != null) throw error;
      },
    )..start();
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _poll.setVisible(
      TickerMode.of(context) && (ModalRoute.of(context)?.isCurrent ?? true),
    );
  }

  @override
  void dispose() {
    _poll.dispose();
    super.dispose();
  }

  void _apply(ShiftReportDetail report) {
    _report = report;
    if (report.serverNow != null) {
      _anchor = report.serverNow;
      _sinceAnchor
        ..reset()
        ..start();
    }
  }

  /// Returns the failure, if any (for the poller's backoff).
  Future<Object?> _load({bool silent = false, bool background = false}) async {
    final stamp = ++_generation;
    if (!silent) {
      setState(() {
        _loading = true;
        _error = null;
      });
    }
    try {
      final report = await context.read<VenueManagerProvider>().loadReport(
        widget.event.id,
        background: background,
      );
      if (report.shiftId != widget.event.id) {
        throw StateError('The report returned belongs to another shift.');
      }
      if (mounted && stamp == _generation) {
        setState(() {
          _apply(report);
          _error = null;
          _stale = false;
        });
      }
      return null;
    } catch (e) {
      // A silent refresh never replaces good rows with an error — except a
      // permanent refusal (401/403/404/410), which drops them: the screen never
      // keeps showing a report the server has just refused.
      final refused =
          e is ApiException &&
          const {401, 403, 404, 410}.contains(e.statusCode);
      if (mounted && stamp == _generation) {
        if (!silent || _report == null || refused) {
          setState(() {
            if (refused) {
              _report = null;
              _stale = false;
            }
            _error = e;
          });
        } else {
          setState(() => _stale = true);
        }
      }
      return e;
    } finally {
      if (mounted && stamp == _generation) setState(() => _loading = false);
    }
  }

  Future<void> _onAction(ShiftReportStaffRow row, TeamRowAction action) async {
    final report = _report;
    if (report == null) return;
    final policy = report.attendancePolicy;
    final first = _firstName(row.staffName);
    final clockIn = action == TeamRowAction.clockIn;
    final title = clockIn ? 'Clock in $first?' : 'Clock out $first?';
    final subtitle = clockIn
        ? 'Clock in on behalf of this team member.'
        : 'Clock out on behalf of this team member.';
    // Known refusals are explained without sending anything.
    if (clockIn && !row.checkedIn) {
      return _blocked(
        title: title,
        subtitle: subtitle,
        panelTitle: "Staff hasn't checked in yet",
        panelMessage: '$first must check in before you can clock them in.',
      );
    }
    if (clockIn &&
        policy?.geofenceEnforced == true &&
        !row.checkInLocationVerified) {
      return _blocked(
        title: title,
        subtitle: subtitle,
        panelTitle: 'Check-in not location-verified',
        panelMessage:
            "This venue requires location, and $first's check-in was not location-verified. Ask them to clock in on their phone, or record their attendance in the shift report.",
      );
    }
    if (!clockIn && policy != null && !policy.onBehalfClockOutAllowed) {
      return _blocked(
        title: title,
        subtitle: subtitle,
        panelTitle: "Clock-out on behalf isn't available here",
        panelMessage:
            "This venue requires location for clock-out, which a manager can't provide. Ask $first to clock out on their phone, or record the clock-out after the shift in Review staff report → Record attendance.",
        row: row,
      );
    }
    final fresh = await showScheduleSheet<ShiftReportDetail>(
      context: context,
      builder: (_) => ChangeNotifierProvider.value(
        value: context.read<VenueManagerProvider>(),
        child: OnBehalfReasonSheet(
          report: report,
          row: row,
          action: action,
          venue: widget.event.venue,
        ),
      ),
    );
    if (!mounted) return;
    if (fresh != null && fresh.shiftId == widget.event.id) {
      setState(() => _apply(fresh));
    } else {
      // Cancelled or refused: re-read, the seat may have changed meanwhile.
      _load(silent: true);
    }
  }

  Future<void> _blocked({
    required String title,
    required String subtitle,
    required String panelTitle,
    required String panelMessage,
    ShiftReportStaffRow? row,
  }) async {
    final report = _report;
    final openReport = row != null && report != null;
    final open = await showScheduleSheet<bool>(
      context: context,
      builder: (sheet) => Column(
        key: const ValueKey('team-blocked-sheet'),
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(title, style: ScheduleType.cardTitle.copyWith(fontSize: 22)),
          const SizedBox(height: 6),
          Text(subtitle, style: ScheduleType.secondary),
          const SizedBox(height: 18),
          _ErrorPanel(title: panelTitle, message: panelMessage),
          const SizedBox(height: ScheduleTokens.sheetActionGap),
          if (openReport) ...[
            SchedulePrimaryButton(
              label: 'Review staff report',
              light: true,
              onPressed: () => Navigator.pop(sheet, true),
            ),
            const SizedBox(height: 10),
          ],
          SchedulePrimaryButton(
            label: 'Back',
            onPressed: () => Navigator.pop(sheet, false),
          ),
        ],
      ),
    );
    if (open == true && openReport && mounted) {
      final roster = ShiftRoster.fromReport(report);
      final member = roster.members
          .where((m) => m.staffProfileId == row.staffProfileId)
          .firstOrNull;
      if (member != null && await openSeatAttendance(context, roster, member)) {
        if (mounted) _load(silent: true);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final e = widget.event;
    final report = _report;
    final canEdit = p.allows('attendance.edit');
    final day = DateUtils.isSameDay(e.start, _now?.toLocal() ?? e.start)
        ? 'Today'
        : DateFormat('EEE d MMM').format(e.start);
    final rows = report?.staff ?? const <ShiftReportStaffRow>[];
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: ScheduleTokens.background,
        body: SafeArea(
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(8, 4, 8, 0),
                child: ScheduleNavHeader(title: 'Teams'),
              ),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: _load,
                  child: ListView(
                    key: const ValueKey('vm-teams-list'),
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
                    children: [
                      ShiftSummaryNavyCard(
                        venue: e.venue,
                        schedule: '$day · ${_hm(e.start)} – ${_hm(e.end)}',
                        photoFileId: e.json['venuePhotoFileId'] as String?,
                        placeholderColor: ScheduleTokens.lavender,
                        countdown: _TeamsCountdown(
                          startsAt: report?.startsAt ?? e.start,
                          endsAt: report?.endsAt ?? e.end,
                          now: () => _now,
                        ),
                      ),
                      const SizedBox(height: 22),
                      _SectionTitle(title: 'Team Leader', count: 1),
                      const SizedBox(height: 8),
                      _LeaderRow(
                        name: widget.leaderName ?? 'You',
                        time: '${_hm(e.start)} – ${_hm(e.end)}',
                      ),
                      const SizedBox(height: 22),
                      _SectionTitle(
                        title: 'Your team',
                        count: report == null ? null : rows.length,
                      ),
                      const SizedBox(height: 8),
                      if (report != null && _stale) const StaleRefreshNotice(),
                      if (report == null && _loading)
                        const Padding(
                          padding: EdgeInsets.all(24),
                          child: Center(child: CircularProgressIndicator()),
                        )
                      else if (report == null)
                        ScheduleMessageCard(
                          title: 'Team unavailable',
                          message: _error is StateError
                              ? "This shift's staff could not be matched. Please try again."
                              : userMessageFor(
                                  _error ?? 'unknown',
                                  fallback: 'Unable to load your team.',
                                ),
                          kind: ScheduleMessageKind.error,
                          actionLabel: 'Retry',
                          onAction: _load,
                        )
                      else if (rows.isEmpty)
                        const ScheduleMessageCard(
                          title: 'No confirmed staff yet.',
                        )
                      else
                        _TeamCard(
                          rows: rows,
                          report: report,
                          venue: e.venue,
                          actionFor: (r) => teamRowAction(
                            r,
                            canEdit: canEdit,
                            finalised: report.isFinalised,
                          ),
                          onAction: _onAction,
                        ),
                    ],
                  ),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Only this subtree ticks. Server-anchored; no device-clock fallback.
class _TeamsCountdown extends StatefulWidget {
  const _TeamsCountdown({
    required this.startsAt,
    required this.endsAt,
    required this.now,
  });
  final DateTime startsAt, endsAt;
  final DateTime? Function() now;
  @override
  State<_TeamsCountdown> createState() => _TeamsCountdownState();
}

class _TeamsCountdownState extends State<_TeamsCountdown> {
  Timer? _tick;
  @override
  void initState() {
    super.initState();
    _tick = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted && TickerMode.of(context)) setState(() {});
    });
  }

  @override
  void dispose() {
    _tick?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = widget.now();
    if (now == null) {
      return const ShiftCountdownPanel(heading: 'Shift time', seconds: null);
    }
    if (now.isBefore(widget.startsAt)) {
      return ShiftCountdownPanel.phase(
        phase: ShiftCountdownPhase.beforeStart,
        seconds: widget.startsAt.difference(now).inSeconds,
      );
    }
    if (now.isBefore(widget.endsAt)) {
      return ShiftCountdownPanel.phase(
        phase: ShiftCountdownPhase.inProgress,
        seconds: now.difference(widget.startsAt).inSeconds,
      );
    }
    return ShiftCountdownPanel.phase(
      phase: ShiftCountdownPhase.ended,
      seconds: null,
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle({required this.title, this.count});
  final String title;
  final int? count;
  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.end,
    children: [
      Expanded(
        child: Semantics(
          header: true,
          child: Text(title, style: ScheduleType.cardTitle),
        ),
      ),
      if (count != null)
        Text(
          '$count ${count == 1 ? 'person' : 'people'}',
          style: ScheduleType.caption,
        ),
    ],
  );
}

const _youFill = Color(0xFFD6EFE2);

class _LeaderRow extends StatelessWidget {
  const _LeaderRow({required this.name, required this.time});
  final String name, time;
  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('team-leader-row'),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
    decoration: BoxDecoration(
      color: const Color(0xFFEFF8F3),
      borderRadius: BorderRadius.circular(16),
      border: Border.all(color: vmRowBorder),
    ),
    child: Row(
      children: [
        ScheduleInitialsAvatar(name: name, size: 42, color: _youFill),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text(name, style: ScheduleType.bodyStrong),
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 2,
                    ),
                    decoration: BoxDecoration(
                      color: _youFill,
                      borderRadius: BorderRadius.circular(6),
                    ),
                    child: Text(
                      'You',
                      style: ScheduleType.badge.copyWith(
                        fontSize: 12,
                        color: CountdownPalette.green,
                      ),
                    ),
                  ),
                ],
              ),
              Text(time, style: ScheduleType.caption),
            ],
          ),
        ),
      ],
    ),
  );
}

class _TeamCard extends StatelessWidget {
  const _TeamCard({
    required this.rows,
    required this.report,
    required this.venue,
    required this.actionFor,
    required this.onAction,
  });
  final List<ShiftReportStaffRow> rows;
  final ShiftReportDetail report;
  final String venue;
  final TeamRowAction? Function(ShiftReportStaffRow) actionFor;
  final void Function(ShiftReportStaffRow, TeamRowAction) onAction;

  static const _tones = [
    ScheduleTokens.lavender,
    Color(0xFFEDEEF2),
    ScheduleTokens.homeMint,
  ];

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: ScheduleTokens.border),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < rows.length; i++) ...[
          if (i > 0) const Divider(height: 1, color: ScheduleTokens.border),
          _TeamRow(
            row: rows[i],
            tone: _tones[i % _tones.length],
            start: rows[i].scheduledStart ?? report.startsAt,
            end: rows[i].scheduledEnd ?? report.endsAt,
            action: actionFor(rows[i]),
            onAction: onAction,
          ),
        ],
      ],
    ),
  );
}

class _TeamRow extends StatelessWidget {
  const _TeamRow({
    required this.row,
    required this.tone,
    required this.start,
    required this.end,
    required this.action,
    required this.onAction,
  });
  final ShiftReportStaffRow row;
  final Color tone;
  final DateTime start, end;
  final TeamRowAction? action;
  final void Function(ShiftReportStaffRow, TeamRowAction) onAction;

  @override
  Widget build(BuildContext context) {
    final (label, chipTone) = teamRowState(row);
    final (fill, ink) = switch (chipTone) {
      TeamChipTone.ok => (CountdownPalette.mint, CountdownPalette.green),
      TeamChipTone.warning => (
        const Color(0xFFFFE9C7),
        const Color(0xFF8A4B00),
      ),
      TeamChipTone.danger => (
        ScheduleTokens.dangerSoft,
        ScheduleTokens.errorText,
      ),
      TeamChipTone.neutral => (const Color(0xFFEDEEF2), ScheduleTokens.ink),
    };
    final byManager = row.clockInMethod == 'manager_on_behalf'
        ? row.clockInByName
        : null;
    final narrow =
        MediaQuery.sizeOf(context).width < 360 ||
        MediaQuery.textScalerOf(context).scale(14) > 20;
    final button = action == null
        ? null
        : FilledButton(
            key: ValueKey('team-action-${row.staffProfileId}'),
            onPressed: () => onAction(row, action!),
            style: FilledButton.styleFrom(
              backgroundColor: ScheduleTokens.accent,
              foregroundColor: Colors.white,
              minimumSize: const Size(0, 34),
              padding: const EdgeInsets.symmetric(horizontal: 12),
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(8),
              ),
              textStyle: ScheduleType.badge.copyWith(
                fontSize: 13,
                fontFamily: Theme.of(context).textTheme.labelLarge?.fontFamily,
              ),
            ),
            child: Text(
              action == TeamRowAction.clockIn ? 'Clock-In' : 'Clock-out',
            ),
          );
    final details = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          row.staffName,
          maxLines: 2,
          overflow: TextOverflow.ellipsis,
          style: ScheduleType.bodyStrong,
        ),
        Text('${_hm(start)} – ${_hm(end)}', style: ScheduleType.caption),
        const SizedBox(height: 6),
        Container(
          key: ValueKey('team-chip-${row.staffProfileId}'),
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
          decoration: BoxDecoration(
            color: fill,
            borderRadius: BorderRadius.circular(999),
          ),
          child: Text(
            label,
            style: ScheduleType.badge.copyWith(fontSize: 12, color: ink),
          ),
        ),
        if (byManager != null) ...[
          const SizedBox(height: 4),
          Text('Clocked in by $byManager', style: ScheduleType.caption),
        ],
        if (narrow && button != null) ...[const SizedBox(height: 8), button],
      ],
    );
    return Padding(
      key: ValueKey('team-row-${row.staffProfileId}'),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          ScheduleInitialsAvatar(name: row.staffName, size: 42, color: tone),
          const SizedBox(width: 12),
          Expanded(child: details),
          if (!narrow && button != null) ...[const SizedBox(width: 10), button],
        ],
      ),
    );
  }
}

class _ErrorPanel extends StatelessWidget {
  const _ErrorPanel({required this.title, required this.message, super.key});
  final String title, message;
  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: true,
    child: Container(
      width: double.infinity,
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: const Color(0xFFFDECEC),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: const Color(0xFFF3C7C7)),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Icon(
            Icons.error_outline,
            size: 22,
            color: ScheduleTokens.errorText,
          ),
          const SizedBox(width: 10),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  title,
                  style: ScheduleType.bodyStrong.copyWith(
                    color: ScheduleTokens.errorText,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  message,
                  style: ScheduleType.secondary.copyWith(
                    color: ScheduleTokens.errorText,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    ),
  );
}

/// "Clock in Lucy?" / "Clock out Lucy?": staff mini-card, a required reason
/// of at least [AttendancePolicy.onBehalfReasonMinWords] words (the server
/// re-checks), Cancel + Confirm. Pops with the server's report on success; a
/// refusal stays in the sheet as an error panel.
class OnBehalfReasonSheet extends StatefulWidget {
  const OnBehalfReasonSheet({
    super.key,
    required this.report,
    required this.row,
    required this.action,
    required this.venue,
  });
  final ShiftReportDetail report;
  final ShiftReportStaffRow row;
  final TeamRowAction action;
  final String venue;
  @override
  State<OnBehalfReasonSheet> createState() => _OnBehalfReasonSheetState();
}

class _OnBehalfReasonSheetState extends State<OnBehalfReasonSheet> {
  final _reason = TextEditingController();
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _reason.dispose();
    super.dispose();
  }

  int get _minWords =>
      widget.report.attendancePolicy?.onBehalfReasonMinWords ?? 10;

  Future<void> _submit() async {
    if (_busy || reasonWordCount(_reason.text) < _minWords) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    final p = context.read<VenueManagerProvider>();
    try {
      final fresh = widget.action == TeamRowAction.clockIn
          ? await p.clockInOnBehalf(
              widget.report.shiftId,
              widget.row.staffProfileId,
              reason: _reason.text,
            )
          : await p.clockOutOnBehalf(
              widget.report.shiftId,
              widget.row.staffProfileId,
              reason: _reason.text,
            );
      // Owner decision: no success toast — the row shows the new state.
      if (mounted) Navigator.of(context).pop(fresh);
    } catch (e) {
      if (mounted) setState(() => _error = AttendanceMessages.forManager(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row;
    final first = _firstName(row.staffName);
    final clockIn = widget.action == TeamRowAction.clockIn;
    final words = reasonWordCount(_reason.text);
    final enough = words >= _minWords;
    final start = row.scheduledStart ?? widget.report.startsAt;
    final end = row.scheduledEnd ?? widget.report.endsAt;
    return Column(
      key: const ValueKey('team-reason-sheet'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          clockIn ? 'Clock in $first?' : 'Clock out $first?',
          style: ScheduleType.cardTitle.copyWith(fontSize: 22),
        ),
        const SizedBox(height: 6),
        Text(
          clockIn
              ? 'Clock in on behalf of this team member.'
              : 'Clock out on behalf of this team member.',
          style: ScheduleType.secondary,
        ),
        const SizedBox(height: 16),
        Container(
          padding: const EdgeInsets.all(12),
          decoration: BoxDecoration(
            color: ScheduleTokens.homeBackground,
            borderRadius: BorderRadius.circular(16),
          ),
          child: Row(
            children: [
              ScheduleInitialsAvatar(
                name: row.staffName,
                size: 40,
                color: ScheduleTokens.lavender,
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(row.staffName, style: ScheduleType.bodyStrong),
                    Text(
                      '${widget.venue} · ${_hm(start)}–${_hm(end)}',
                      style: ScheduleType.caption,
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 18),
        Text('Reason*', style: ScheduleType.bodyStrong),
        const SizedBox(height: 8),
        TextField(
          key: const ValueKey('team-reason-field'),
          controller: _reason,
          enabled: !_busy,
          minLines: 3,
          maxLines: 5,
          textCapitalization: TextCapitalization.sentences,
          inputFormatters: [LengthLimitingTextInputFormatter(1000)],
          onChanged: (_) => setState(() {}),
          decoration: InputDecoration(
            hintText: clockIn
                ? 'Add a $_minWords words reason for this manual clock-in…'
                : 'Add a $_minWords words reason for this manual clock-out…',
            hintMaxLines: 3,
            filled: true,
            fillColor: Colors.white,
            border: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: const BorderSide(color: ScheduleTokens.border),
            ),
            enabledBorder: OutlineInputBorder(
              borderRadius: BorderRadius.circular(14),
              borderSide: const BorderSide(color: ScheduleTokens.border),
            ),
          ),
        ),
        const SizedBox(height: 6),
        Text(
          enough
              ? '$words words'
              : '$words of $_minWords words — add at least $_minWords words.',
          key: const ValueKey('team-reason-count'),
          style: ScheduleType.caption.copyWith(
            color: enough || words == 0
                ? ScheduleTokens.muted
                : ScheduleTokens.errorText,
          ),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          _ErrorPanel(
            key: const ValueKey('team-reason-error'),
            title: clockIn ? 'Clock-in not recorded' : 'Clock-out not recorded',
            message: _error!,
          ),
        ],
        const SizedBox(height: ScheduleTokens.sheetActionGap),
        Row(
          children: [
            Expanded(
              flex: 2,
              child: SchedulePrimaryButton(
                label: 'Cancel',
                light: true,
                onPressed: _busy ? null : () => Navigator.pop(context),
              ),
            ),
            const SizedBox(width: 10),
            Expanded(
              flex: 3,
              child: SchedulePrimaryButton(
                key: const ValueKey('team-reason-confirm'),
                label: clockIn ? 'Confirm clock-in' : 'Confirm clock-out',
                busy: _busy,
                onPressed: enough ? _submit : null,
              ),
            ),
          ],
        ),
      ],
    );
  }
}
