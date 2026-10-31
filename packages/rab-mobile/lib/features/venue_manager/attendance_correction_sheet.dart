import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_toast.dart';
import 'report_ui.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

/// Why a manager is entering attendance — wire codes and labels of the server's `ATTENDANCE_RECORD_REASONS`.
const attendanceRecordReasons = <(String, String)>[
  ('forgot_clock_in', 'Staff forgot to clock in'),
  ('forgot_clock_out', 'Staff forgot to clock out'),
  ('app_issue', 'Mobile application issue'),
  ('venue_issue', 'Venue operational issue'),
  ('other', 'Other'),
];

/// Opens "Record attendance" for one seat. Resolves to the server's authoritative report after a confirmed save, or
/// null when the manager closes it. Nothing is saved locally: the caller renders only what the server returned.
Future<ShiftReportDetail?> showAttendanceEntrySheet(
  BuildContext context, {
  required ShiftReportDetail report,
  required ShiftReportStaffRow row,
  DateTime Function()? clock,
}) => showScheduleSheet<ShiftReportDetail>(
  context: context,
  // A save in flight must not be abandoned by a stray tap outside the sheet.
  isDismissible: false,
  enableDrag: false,
  builder: (_) => AttendanceEntrySheet(report: report, row: row, clock: clock),
);

/// Presentation-only preview of the worked time (span minus the unpaid break, never below zero), shown while the
/// manager types. The authoritative figure is computed by the server with `@rab/shared` duration.ts when saved.
int? previewWorkedMinutes(
  DateTime? clockIn,
  DateTime? clockOut,
  int? breakMinutes,
) {
  if (clockIn == null || clockOut == null || !clockOut.isAfter(clockIn)) {
    return null;
  }
  final span = (clockOut.difference(clockIn).inSeconds / 60).round();
  final worked = span - (breakMinutes ?? 0);
  return worked < 0 ? 0 : worked;
}

String _hm(int minutes) => minutes % 60 == 0
    ? '${minutes ~/ 60}h'
    : '${minutes ~/ 60}h ${minutes % 60}m';

/// "Record attendance" form: the manager's VERIFIED actual clock-in / clock-out (date + time pickers, never pre-filled
/// with the scheduled times; existing recorded values are shown), the break, a live worked-time preview, and a required
/// reason (+ explanation for Other). Submits once to `POST .../record-attendance` with the version it was opened with.
class AttendanceEntrySheet extends StatefulWidget {
  const AttendanceEntrySheet({
    super.key,
    required this.report,
    required this.row,
    this.clock,
  });
  final ShiftReportDetail report;
  final ShiftReportStaffRow row;

  /// Device time for the "not in the future" pre-check and the time picker's starting dial (tests pass a fixed one).
  /// The server's own clock is what decides.
  final DateTime Function()? clock;

  @override
  State<AttendanceEntrySheet> createState() => _AttendanceEntrySheetState();
}

class _AttendanceEntrySheetState extends State<AttendanceEntrySheet> {
  late DateTime? _in = widget.row.clockInAt?.toLocal();
  late DateTime? _out = widget.row.clockOutAt?.toLocal();
  late final _break = TextEditingController(
    text: '${widget.row.breakMinutes ?? widget.row.scheduledBreakMinutes}',
  );
  final _note = TextEditingController();
  String? _reason;
  bool _saving = false;
  final _errors = <String, String>{};

  DateTime _now() => (widget.clock ?? DateTime.now)();

  @override
  void initState() {
    super.initState();
    _break.addListener(() => setState(() => _errors.remove('break')));
  }

  @override
  void dispose() {
    _break.dispose();
    _note.dispose();
    super.dispose();
  }

  static DateTime _day(DateTime d) => DateTime(d.year, d.month, d.day);

  /// Date, then time. The pickers only START at the scheduled day (and the current time of day); nothing is stored
  /// until the manager confirms both.
  Future<void> _pick({required bool clockIn}) async {
    final existing = clockIn ? _in : _out;
    final scheduled =
        (clockIn ? widget.row.scheduledStart : widget.row.scheduledEnd)
            ?.toLocal() ??
        widget.report.startsAt.toLocal();
    final first = _day(
      (widget.row.scheduledStart ?? widget.report.startsAt).toLocal(),
    ).subtract(const Duration(days: 1));
    final last = _day(
      (widget.row.scheduledEnd ?? widget.report.endsAt).toLocal(),
    ).add(const Duration(days: 1));
    var initial = _day(existing ?? scheduled);
    if (initial.isBefore(first)) initial = first;
    if (initial.isAfter(last)) initial = last;
    final date = await showDatePicker(
      context: context,
      initialDate: initial,
      firstDate: first,
      lastDate: last,
      helpText: clockIn ? 'Actual clock-in date' : 'Actual clock-out date',
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(existing ?? _now()),
      helpText: clockIn ? 'Actual clock-in time' : 'Actual clock-out time',
    );
    if (time == null || !mounted) return;
    final value = DateTime(
      date.year,
      date.month,
      date.day,
      time.hour,
      time.minute,
    );
    setState(() {
      if (clockIn) {
        _in = value;
      } else {
        _out = value;
      }
      _errors
        ..remove('in')
        ..remove('out')
        ..remove('break');
    });
  }

  int? get _breakValue => int.tryParse(_break.text.trim());

  bool _validate() {
    _errors.clear();
    final now = _now();
    if (_in == null) {
      _errors['in'] = 'Select the actual clock-in date and time.';
    }
    if (_out == null) {
      _errors['out'] = 'Select the actual clock-out date and time.';
    }
    if (_in != null && _in!.isAfter(now)) {
      _errors['in'] = 'The clock-in time cannot be in the future.';
    }
    if (_out != null && _out!.isAfter(now)) {
      _errors['out'] = 'The clock-out time cannot be in the future.';
    }
    if (_in != null && _out != null && !_out!.isAfter(_in!)) {
      _errors['out'] =
          'The clock-out must be after the clock-in. If they finished after midnight, choose the next day.';
    }
    final b = _breakValue;
    if (b == null || b < 0 || b > 1440) {
      _errors['break'] = 'Enter the break in whole minutes.';
    } else if (_in != null &&
        _out != null &&
        _out!.isAfter(_in!) &&
        b >= (_out!.difference(_in!).inSeconds / 60).round()) {
      _errors['break'] =
          'The break must be shorter than the time between clock-in and clock-out.';
    }
    if (_reason == null) _errors['reason'] = 'Select a reason.';
    if (_reason == 'other' && _note.text.trim().length < 10) {
      _errors['note'] = 'Explain the reason in at least 10 characters.';
    }
    return _errors.isEmpty;
  }

  Future<void> _save() async {
    if (!_validate()) {
      setState(() {});
      return;
    }
    setState(() => _saving = true);
    final overlay = ScheduleToast.overlayOf(context);
    try {
      final fresh = await context.read<VenueManagerProvider>().recordAttendance(
        widget.report.shiftId,
        widget.row.staffProfileId,
        clockInAt: _in,
        clockOutAt: _out,
        breakMinutes: _breakValue,
        reasonCode: _reason!,
        reasonNote: _reason == 'other' ? _note.text : null,
        expectedVersion: widget.row.attendanceVersion,
      );
      // Owner decision: no success toast — the review screen shows the saved attendance itself.
      if (mounted) Navigator.of(context).pop(fresh);
    } catch (e) {
      if (!mounted || overlay == null) return;
      final invalid =
          e is ApiException &&
          (e.code == 'INVALID_ATTENDANCE_TIMES' || e.statusCode == 400);
      ScheduleToast.showOn(
        overlay,
        invalid
            ? userMessageFor(
                e,
                fallback: 'Check the clock-in, clock-out and break values.',
              )
            : userMessageFor(e),
        kind: ScheduleMessageKind.error,
        title: invalid ? 'Invalid attendance times' : 'Attendance not saved',
      );
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final row = widget.row, report = widget.report;
    final scheduledStart = row.scheduledStart ?? report.startsAt;
    final scheduledEnd = row.scheduledEnd ?? report.endsAt;
    final worked = previewWorkedMinutes(_in, _out, _breakValue);
    final enabled = !_saving;
    return PopScope(
      canPop: !_saving,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Text('Record attendance', style: ScheduleType.cardTitle),
          const SizedBox(height: 4),
          Text(
            'Enter the times you have verified. Do not copy the scheduled times unless they are what happened.',
            style: ScheduleType.caption,
          ),
          const SizedBox(height: 14),
          Container(
            key: const Key('entry-staff-details'),
            padding: const EdgeInsets.all(14),
            decoration: BoxDecoration(
              color: ReportTokens.page,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(row.staffName, style: ScheduleType.bodyStrong),
                Text(
                  '${report.venueName} · ${row.roleName}',
                  style: ScheduleType.caption,
                ),
                Text(
                  '${reportDate(scheduledStart)} · Scheduled ${reportTimeRange(scheduledStart, scheduledEnd)}',
                  style: ScheduleType.caption,
                ),
              ],
            ),
          ),
          const SizedBox(height: 16),
          _field(
            'Actual clock-in',
            _timeBox(
              key: const Key('entry-clock-in'),
              value: _in,
              onTap: enabled ? () => _pick(clockIn: true) : null,
            ),
            error: _errors['in'],
          ),
          const SizedBox(height: 14),
          _field(
            'Actual clock-out',
            _timeBox(
              key: const Key('entry-clock-out'),
              value: _out,
              onTap: enabled ? () => _pick(clockIn: false) : null,
            ),
            error: _errors['out'],
          ),
          const SizedBox(height: 14),
          _field(
            'Break (minutes)',
            TextField(
              key: const Key('entry-break'),
              controller: _break,
              enabled: enabled,
              keyboardType: TextInputType.number,
              style: ScheduleType.body,
              decoration: _box('Minutes').copyWith(
                helperText: 'Scheduled: ${row.scheduledBreakMinutes} min',
              ),
            ),
            error: _errors['break'],
          ),
          const SizedBox(height: 14),
          Container(
            key: const Key('entry-worked-preview'),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
            decoration: BoxDecoration(
              border: Border.all(color: ReportTokens.divider),
              borderRadius: BorderRadius.circular(14),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text('Worked time', style: ScheduleType.body),
                    ),
                    Text(
                      worked == null ? '—' : _hm(worked),
                      key: const Key('entry-worked-value'),
                      style: ScheduleType.bodyStrong,
                    ),
                  ],
                ),
                const SizedBox(height: 2),
                Text(
                  'Preview only. Hours and pay are calculated when you save.',
                  style: ScheduleType.caption,
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          _field(
            'Reason for recording attendance',
            DropdownButtonFormField<String>(
              key: const Key('entry-reason'),
              initialValue: _reason,
              isExpanded: true,
              hint: Text('Select a reason', style: ScheduleType.secondary),
              style: ScheduleType.body,
              decoration: _box(null),
              items: [
                for (final (code, label) in attendanceRecordReasons)
                  DropdownMenuItem(
                    value: code,
                    child: Text(label, overflow: TextOverflow.ellipsis),
                  ),
              ],
              onChanged: enabled
                  ? (v) => setState(() {
                      _reason = v;
                      _errors
                        ..remove('reason')
                        ..remove('note');
                    })
                  : null,
            ),
            error: _errors['reason'],
          ),
          if (_reason == 'other') ...[
            const SizedBox(height: 14),
            _field(
              'Explanation',
              TextField(
                key: const Key('entry-note'),
                controller: _note,
                enabled: enabled,
                minLines: 2,
                maxLines: 4,
                maxLength: 500,
                style: ScheduleType.body,
                decoration: _box('Explain what happened…'),
                onChanged: (_) => setState(() => _errors.remove('note')),
              ),
              error: _errors['note'],
            ),
          ],
          const SizedBox(height: 20),
          SchedulePrimaryButton(
            key: const Key('save-attendance'),
            label: 'Save attendance',
            background: ScheduleTokens.navy,
            busy: _saving,
            onPressed: _save,
          ),
          const SizedBox(height: 8),
          TextButton(
            key: const Key('cancel-attendance'),
            onPressed: _saving ? null : () => Navigator.of(context).pop(),
            child: Text('Cancel', style: ScheduleType.button),
          ),
        ],
      ),
    );
  }

  Widget _field(String label, Widget child, {String? error}) => Column(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text(label, style: ScheduleType.caption),
      const SizedBox(height: 6),
      child,
      if (error != null) ...[
        const SizedBox(height: 6),
        Text(
          error,
          style: ScheduleType.caption.copyWith(color: ScheduleTokens.errorText),
        ),
      ],
    ],
  );

  Widget _timeBox({
    required Key key,
    required DateTime? value,
    required VoidCallback? onTap,
  }) => Material(
    color: Colors.white,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(14),
      side: const BorderSide(color: ReportTokens.divider),
    ),
    child: InkWell(
      key: key,
      borderRadius: BorderRadius.circular(14),
      onTap: onTap,
      child: Container(
        constraints: const BoxConstraints(minHeight: 52),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
        alignment: Alignment.centerLeft,
        child: Row(
          children: [
            Expanded(
              child: Text(
                value == null
                    ? 'Select date and time'
                    : DateFormat('EEE d MMM yyyy, HH:mm').format(value),
                style: value == null
                    ? ScheduleType.secondary
                    : ScheduleType.body,
              ),
            ),
            const Icon(Icons.schedule, size: 20, color: ReportTokens.muted),
          ],
        ),
      ),
    ),
  );

  static InputDecoration _box(String? hint) => InputDecoration(
    hintText: hint,
    filled: true,
    fillColor: Colors.white,
    contentPadding: const EdgeInsets.all(14),
    border: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: ReportTokens.divider),
    ),
    enabledBorder: OutlineInputBorder(
      borderRadius: BorderRadius.circular(14),
      borderSide: const BorderSide(color: ReportTokens.divider),
    ),
  );
}
