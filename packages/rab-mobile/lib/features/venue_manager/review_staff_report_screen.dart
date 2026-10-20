import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'report_ui.dart';
import 'shift_report.dart';
import 'shift_report_screen.dart' show staffReportBadge, workedLabel;
import 'venue_manager_provider.dart';

enum _Tab { attendance, review }

enum CorrectionField { clockInAt, clockOutAt, breakMinutes }

/// "Review staff report". Attendance tab: "Save correction" sends one field through the audited endpoint
/// (`POST /attendance/:id/correct`, reason required server-side) and, only once the server confirmed it, reloads the
/// report so the screen shows the SAVED value ("Corrected · Awaiting review"); "Mark reviewed" is the separate,
/// explicit attendance review (`POST .../attendance-review`) that turns the seat green. Staff review tab: the optional
/// per-shift performance rating (`PUT .../reviews/:staffProfileId`). The report screen reloads on return.
class ReviewStaffReportScreen extends StatefulWidget {
  const ReviewStaffReportScreen({
    super.key,
    required this.report,
    required this.row,
    this.initialReview = false,
  });
  final ShiftReportDetail report;
  final ShiftReportStaffRow row;
  final bool initialReview;

  @override
  State<ReviewStaffReportScreen> createState() =>
      _ReviewStaffReportScreenState();
}

class _ReviewStaffReportScreenState extends State<ReviewStaffReportScreen> {
  late _Tab _tab = widget.initialReview ? _Tab.review : _Tab.attendance;
  final _attendance = GlobalKey<_AttendanceTabState>();
  final _review = GlobalKey<_ReviewTabState>();

  /// The authoritative report/row: replaced only by server responses (never edited locally).
  late ShiftReportDetail _report = widget.report;
  late ShiftReportStaffRow _row = widget.row;
  bool _saving = false;
  bool _reviewing = false;
  String? _confirmation;
  String? _reviewError;

  bool get _busy => _saving || _reviewing;

  void _adopt(ShiftReportDetail fresh) {
    _report = fresh;
    _row = fresh.staff.firstWhere(
      (s) => s.staffProfileId == widget.row.staffProfileId,
      orElse: () => _row,
    );
  }

  Future<void> _saveCorrection() async {
    setState(() {
      _saving = true;
      _confirmation = null;
      _reviewError = null;
    });
    final saved = await _attendance.currentState?.save();
    if (!mounted) return;
    if (saved == null) {
      setState(() => _saving = false);
      return;
    }
    // The server confirmed the correction; show what it actually stored, not what was typed.
    try {
      final fresh = await context.read<VenueManagerProvider>().loadReport(
        _report.shiftId,
      );
      if (!mounted) return;
      setState(() {
        _adopt(fresh);
        _confirmation = _savedMessage(saved, _row);
      });
      _attendance.currentState?.reset();
    } catch (_) {
      if (mounted) {
        setState(
          () => _confirmation =
              'Correction saved. The report could not be refreshed. Go back and pull to refresh.',
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  static String _savedMessage(String field, ShiftReportStaffRow row) {
    String at(DateTime? d) =>
        d == null ? '—' : DateFormat('EEE d MMM, HH:mm').format(d.toLocal());
    final what = switch (field) {
      'clockOutAt' => 'Clock-out saved: ${at(row.clockOutAt)}.',
      'clockInAt' => 'Clock-in saved: ${at(row.clockInAt)}.',
      _ => 'Break saved: ${row.breakMinutes ?? row.scheduledBreakMinutes} min.',
    };
    return '$what Mark the attendance as reviewed when the hours are right.';
  }

  Future<void> _markReviewed() async {
    setState(() {
      _reviewing = true;
      _reviewError = null;
    });
    try {
      final fresh = await context.read<VenueManagerProvider>().reviewAttendance(
        _report.shiftId,
        _row.staffProfileId,
      );
      if (!mounted) return;
      setState(() => _adopt(fresh));
      if (!_row.attendanceReviewed) {
        // Never claim a success the server's own report does not show.
        setState(
          () => _reviewError = 'The review was not recorded. Please try again.',
        );
        return;
      }
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Attendance reviewed.')));
      Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _reviewError = e.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => _reviewError = 'Something went wrong. Please try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _reviewing = false);
    }
  }

  Future<void> _saveReview() async {
    setState(() => _saving = true);
    final ok = await _review.currentState?.save();
    if (!mounted) return;
    setState(() => _saving = false);
    if (ok == true) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('Review saved.')));
      Navigator.of(context).pop(true);
    }
  }

  /// Why "Mark reviewed" is unavailable, from the server row (null = available, already reviewed or finalised).
  String? get _reviewBlocked {
    final row = _row;
    if (_report.isFinalised || row.attendanceReviewed) return null;
    if (row.isOpen) {
      return 'Still clocked in. Review after clock-out, or once the shift has ended record the clock-out as a correction.';
    }
    if (row.isNoShow) return null;
    if (row.attendanceId == null) {
      return 'No attendance recorded yet. A no-show is recorded automatically 30 minutes after the start.';
    }
    if (row.clockOutAt == null) {
      return 'Add the clock-out time as a correction first.';
    }
    return null;
  }

  Widget _attendanceBar(bool locked) {
    final row = _row;
    final canReview =
        !locked && !row.attendanceReviewed && row.attendanceResolved;
    final blocked = _reviewBlocked;
    final reviewButton = ReportButton(
      key: const Key('mark-attendance-reviewed'),
      label: row.attendanceReviewed
          ? 'Reviewed'
          : (row.isNoShow ? 'Confirm no-show' : 'Mark reviewed'),
      busy: _reviewing,
      onPressed: canReview && !_busy ? _markReviewed : null,
    );
    return ReportBottomBar(
      children: [
        if (blocked != null && !locked)
          Text(
            blocked,
            key: const Key('review-blocked-reason'),
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
          ),
        if (row.attendanceId == null)
          reviewButton
        else
          Row(
            children: [
              Expanded(
                child: ReportButton(
                  key: const Key('save-review-screen'),
                  label: 'Save correction',
                  secondary: true,
                  busy: _saving,
                  onPressed: locked || _busy ? null : _saveCorrection,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(child: reviewButton),
            ],
          ),
      ],
    );
  }

  @override
  Widget build(BuildContext context) {
    final r = _report, row = _row;
    final locked = r.isFinalised;
    return ReportPage(
      title: 'Review staff report',
      body: ListView(
        padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
        children: [
          ReportCard(
            child: Row(
              children: [
                Container(
                  width: 44,
                  height: 44,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: const Color(0xFFE5E7EB),
                    borderRadius: BorderRadius.circular(10),
                  ),
                  child: Text(
                    _initials(row.staffName),
                    style: const TextStyle(
                      fontWeight: FontWeight.w700,
                      color: ReportTokens.muted,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        row.staffName,
                        style: const TextStyle(
                          fontSize: 20,
                          fontWeight: FontWeight.w700,
                          color: ReportTokens.ink,
                        ),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        '${r.venueName} · ${row.roleName}',
                        style: const TextStyle(
                          fontSize: 13,
                          color: ReportTokens.muted,
                        ),
                      ),
                      Text(
                        '${reportDate(r.startsAt)} · ${reportTimeRange(r.startsAt, r.endsAt)}',
                        style: const TextStyle(
                          fontSize: 13,
                          color: ReportTokens.muted,
                        ),
                      ),
                    ],
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          ReportSegments<_Tab>(
            values: _Tab.values,
            labels: const ['Attendance', 'Staff review'],
            selected: _tab,
            onChanged: _busy ? null : (t) => setState(() => _tab = t),
          ),
          const SizedBox(height: 16),
          if (locked)
            const Padding(
              padding: EdgeInsets.only(bottom: 14),
              child: ReportNotice(
                title: 'Report finalised',
                message:
                    'Attendance and reviews are locked after the timesheet is signed off.',
              ),
            ),
          Offstage(
            offstage: _tab != _Tab.attendance,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                _RecordedAttendance(row: row, finalised: locked),
                if (_confirmation != null) ...[
                  const SizedBox(height: 12),
                  ScheduleMessageCard(
                    key: const Key('correction-confirmation'),
                    title: _confirmation!,
                    kind: ScheduleMessageKind.success,
                  ),
                ],
                if (_reviewError != null) ...[
                  const SizedBox(height: 12),
                  ScheduleMessageCard(
                    key: const Key('review-error'),
                    title: _reviewError!,
                    kind: ScheduleMessageKind.error,
                  ),
                ],
                const SizedBox(height: 18),
                _AttendanceTab(
                  key: _attendance,
                  report: r,
                  row: row,
                  locked: locked,
                ),
              ],
            ),
          ),
          Offstage(
            offstage: _tab != _Tab.review,
            child: _ReviewTab(key: _review, report: r, row: row),
          ),
        ],
      ),
      bottom: _tab == _Tab.attendance
          ? _attendanceBar(locked)
          : ReportBottomBar(
              children: [
                Row(
                  children: [
                    Expanded(
                      child: ReportButton(
                        label: 'Cancel',
                        secondary: true,
                        onPressed: _busy
                            ? null
                            : () => Navigator.of(context).pop(false),
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: ReportButton(
                        key: const Key('save-performance-review'),
                        label: 'Save review',
                        busy: _saving,
                        onPressed: locked || _busy ? null : _saveReview,
                      ),
                    ),
                  ],
                ),
              ],
            ),
    );
  }

  static String _initials(String name) => name
      .trim()
      .split(RegExp(r'\s+'))
      .where((p) => p.isNotEmpty)
      .take(2)
      .map((p) => p[0].toUpperCase())
      .join();
}

// ── Attendance correction ────────────────────────────────────────────────────────────────────────────────────────

class _AttendanceTab extends StatefulWidget {
  const _AttendanceTab({
    super.key,
    required this.report,
    required this.row,
    required this.locked,
  });
  final ShiftReportDetail report;
  final ShiftReportStaffRow row;
  final bool locked;

  @override
  State<_AttendanceTab> createState() => _AttendanceTabState();
}

class _AttendanceTabState extends State<_AttendanceTab> {
  late CorrectionField _field;
  late DateTime _date;
  TimeOfDay? _time;
  final _break = TextEditingController();
  final _reason = TextEditingController();
  String? _error;

  bool get _missingOut =>
      widget.row.clockInAt != null &&
      widget.row.clockOutAt == null &&
      widget.row.assignmentStatus != 'no_show';

  @override
  void initState() {
    super.initState();
    _select(
      _missingOut ? CorrectionField.clockOutAt : CorrectionField.clockInAt,
      notify: false,
    );
    _break.text = (widget.row.breakMinutes ?? widget.row.scheduledBreakMinutes)
        .toString();
  }

  @override
  void dispose() {
    _break.dispose();
    _reason.dispose();
    super.dispose();
  }

  static DateTime _day(DateTime d) => DateTime(d.year, d.month, d.day);

  void _select(CorrectionField f, {bool notify = true}) {
    final existing = switch (f) {
      CorrectionField.clockInAt => widget.row.clockInAt?.toLocal(),
      CorrectionField.clockOutAt => widget.row.clockOutAt?.toLocal(),
      CorrectionField.breakMinutes => null,
    };
    void apply() {
      _field = f;
      _time = existing == null
          ? null
          : TimeOfDay(hour: existing.hour, minute: existing.minute);
      // No recorded clock-out yet: start from the scheduled end's day (right for an overnight shift), else the clock-in
      // day; the manager can still move it. Nothing is pre-filled as a time — `_time` stays null until they pick one.
      _date = _day(
        existing ??
            (f == CorrectionField.clockOutAt
                ? widget.row.scheduledEnd?.toLocal()
                : null) ??
            widget.row.clockInAt?.toLocal() ??
            widget.report.startsAt.toLocal(),
      );
      _error = null;
    }

    notify ? setState(apply) : apply();
  }

  DateTime? get _combined => _time == null
      ? null
      : DateTime(
          _date.year,
          _date.month,
          _date.day,
          _time!.hour,
          _time!.minute,
        );

  String? get _orderProblem {
    final v = _combined;
    if (v == null) return null;
    final f = DateFormat('EEE d MMM, HH:mm');
    final ci = widget.row.clockInAt?.toLocal(),
        co = widget.row.clockOutAt?.toLocal();
    if (_field == CorrectionField.clockOutAt && ci != null && v.isBefore(ci)) {
      return 'This is before clock in (${f.format(ci)}). If they clocked out after midnight, change the date.';
    }
    if (_field == CorrectionField.clockInAt && co != null && v.isAfter(co)) {
      return 'This is after clock out (${f.format(co)}). Check the date.';
    }
    return null;
  }

  Future<void> _pickDate() async {
    final anchor = _day(widget.report.startsAt.toLocal());
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: anchor.subtract(const Duration(days: 1)),
      lastDate: anchor.add(const Duration(days: 2)),
    );
    if (picked != null) {
      setState(() {
        _date = _day(picked);
        _error = null;
      });
    }
  }

  Future<void> _pickTime() async {
    // The dial opens at the scheduled boundary (a sensible starting point, not a saved value).
    final anchor = _field == CorrectionField.clockOutAt
        ? widget.row.scheduledEnd
        : widget.row.scheduledStart;
    final picked = await showTimePicker(
      context: context,
      initialTime:
          _time ??
          (anchor == null
              ? TimeOfDay.now()
              : TimeOfDay.fromDateTime(anchor.toLocal())),
    );
    if (picked != null) {
      setState(() {
        _time = picked;
        _error = null;
      });
    }
  }

  /// Clears the form after a confirmed save (the parent now shows the saved value).
  void reset() {
    _reason.clear();
    _select(
      _missingOut ? CorrectionField.clockOutAt : CorrectionField.clockInAt,
    );
    _break.text = (widget.row.breakMinutes ?? widget.row.scheduledBreakMinutes)
        .toString();
  }

  /// Validates, submits to the secured endpoint and waits for it. Returns the corrected field's wire name only after
  /// the server confirmed the save; null on any validation or server error (shown inline, never as success).
  Future<String?> save() async {
    final id = widget.row.attendanceId;
    if (id == null) return null;
    final reason = _reason.text.trim();
    if (reason.length < 10) {
      setState(
        () => _error = 'Please explain this change in at least 10 characters.',
      );
      return null;
    }
    String value;
    if (_field == CorrectionField.breakMinutes) {
      final minutes = int.tryParse(_break.text.trim());
      if (minutes == null || minutes < 0) {
        setState(() => _error = 'Enter a whole number of minutes.');
        return null;
      }
      value = '$minutes';
    } else {
      if (_time == null) {
        setState(() => _error = 'Pick a time.');
        return null;
      }
      final problem = _orderProblem;
      if (problem != null) {
        setState(() => _error = problem);
        return null;
      }
      value = _combined!.toUtc().toIso8601String();
    }
    setState(() => _error = null);
    final field = switch (_field) {
      CorrectionField.clockInAt => 'clockInAt',
      CorrectionField.clockOutAt => 'clockOutAt',
      CorrectionField.breakMinutes => 'breakMinutes',
    };
    try {
      await context.read<VenueManagerProvider>().correctAttendance(
        id,
        field: field,
        newValue: value,
        reason: reason,
      );
      return field;
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Something went wrong. Please try again.');
      }
    }
    return null;
  }

  @override
  Widget build(BuildContext context) {
    if (widget.row.attendanceId == null) {
      return ReportNotice(
        title: widget.row.isNoShow
            ? 'Recorded as a no-show'
            : 'No attendance recorded',
        message: widget.row.isNoShow
            ? '${widget.row.staffName} never clocked in, so no hours are recorded or paid. Confirm the no-show to complete this review. Attendance cannot be created from this screen.'
            : '${widget.row.staffName} has not clocked in, so there is no attendance to correct. Attendance cannot be created from this screen.',
      );
    }
    final enabled = !widget.locked;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        if (_missingOut) ...[
          const ReportNotice(
            title: 'Clock-out time is missing',
            message: 'Add the correct time and a reason for the change.',
          ),
          const SizedBox(height: 18),
        ],
        const Text(
          'Attendance correction',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: ReportTokens.ink,
          ),
        ),
        const SizedBox(height: 12),
        ReportSegments<CorrectionField>(
          values: CorrectionField.values,
          labels: const ['Clock in', 'Clock out', 'Break'],
          selected: _field,
          onChanged: enabled ? _select : null,
        ),
        const SizedBox(height: 16),
        if (_field == CorrectionField.breakMinutes)
          _labelled(
            'Break (minutes)',
            TextField(
              controller: _break,
              enabled: enabled,
              keyboardType: TextInputType.number,
              decoration: _box('Minutes'),
            ),
          )
        else
          Row(
            children: [
              Expanded(
                child: _labelled(
                  'Date',
                  _pickBox(
                    key: const Key('correction-date'),
                    text: DateFormat('EEE d MMM').format(_date),
                    onTap: enabled ? _pickDate : null,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: _labelled(
                  _field == CorrectionField.clockInAt
                      ? 'Clock-in time'
                      : 'Clock-out time',
                  _pickBox(
                    key: const Key('correction-time'),
                    text: _time == null
                        ? 'Select time'
                        : DateFormat('HH:mm').format(_combined!),
                    placeholder: _time == null,
                    onTap: enabled ? _pickTime : null,
                  ),
                ),
              ),
            ],
          ),
        if (_field != CorrectionField.breakMinutes && _combined != null)
          Padding(
            padding: const EdgeInsets.only(top: 8),
            child: Text(
              'Will be saved as ${DateFormat('EEE d MMM yyyy, HH:mm').format(_combined!)}',
              style: const TextStyle(fontSize: 12, color: ReportTokens.muted),
            ),
          ),
        const SizedBox(height: 16),
        _labelled(
          'Reason for correction (required)',
          TextField(
            key: const Key('correction-reason'),
            controller: _reason,
            enabled: enabled,
            minLines: 3,
            maxLines: 5,
            decoration: _box('Add a reason for this correction…'),
          ),
        ),
        const SizedBox(height: 8),
        const Text(
          'Your changes will be recorded with this report.',
          style: TextStyle(fontSize: 12, color: ReportTokens.muted),
        ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          ScheduleMessageCard(title: _error!, kind: ScheduleMessageKind.error),
        ],
      ],
    );
  }
}

// ── Staff review ─────────────────────────────────────────────────────────────────────────────────────────────────

class _ReviewTab extends StatefulWidget {
  const _ReviewTab({super.key, required this.report, required this.row});
  final ShiftReportDetail report;
  final ShiftReportStaffRow row;

  @override
  State<_ReviewTab> createState() => _ReviewTabState();
}

class _ReviewTabState extends State<_ReviewTab> {
  final _ratings = <String, int>{};
  final _feedback = TextEditingController();
  bool _loading = true, _editable = false;
  String? _error, _savedBy;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void dispose() {
    _feedback.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final r = await context.read<VenueManagerProvider>().loadReview(
        widget.report.shiftId,
        widget.row.staffProfileId,
      );
      if (!mounted) return;
      setState(() {
        _editable = r.editable;
        if (r.review != null) {
          _ratings.addAll(r.review!.ratings);
          _feedback.text = r.review!.feedback ?? '';
          _savedBy = r.review!.reviewerName;
        }
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = e is ApiException
              ? e.message
              : 'Could not load the review.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<bool> save() async {
    if (!_editable) return false;
    final missing = staffReviewCategories
        .where((c) => !_ratings.containsKey(c.$1))
        .map((c) => c.$2)
        .toList();
    if (missing.isNotEmpty) {
      setState(
        () => _error = 'Rate every area before saving (${missing.join(', ')}).',
      );
      return false;
    }
    setState(() => _error = null);
    try {
      await context.read<VenueManagerProvider>().saveReview(
        widget.report.shiftId,
        widget.row.staffProfileId,
        ratings: Map.of(_ratings),
        feedback: _feedback.text,
      );
      return true;
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Something went wrong. Please try again.');
      }
    }
    return false;
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Padding(
        padding: EdgeInsets.all(24),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text(
          'Staff performance',
          style: TextStyle(
            fontSize: 18,
            fontWeight: FontWeight.w600,
            color: ReportTokens.ink,
          ),
        ),
        const SizedBox(height: 4),
        const Text(
          'Rate each area from 1 (poor) to 5 (excellent).',
          style: TextStyle(fontSize: 13, color: ReportTokens.muted),
        ),
        const SizedBox(height: 16),
        for (final (key, label) in staffReviewCategories)
          Padding(
            padding: const EdgeInsets.only(bottom: 14),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    label,
                    style: const TextStyle(
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                      color: ReportTokens.ink,
                    ),
                  ),
                ),
                for (var v = 1; v <= 5; v++)
                  Padding(
                    padding: const EdgeInsets.only(left: 6),
                    child: _RatingBox(
                      key: Key('rating-$key-$v'),
                      value: v,
                      label: label,
                      selected: _ratings[key] == v,
                      onTap: _editable
                          ? () => setState(() => _ratings[key] = v)
                          : null,
                    ),
                  ),
              ],
            ),
          ),
        const SizedBox(height: 4),
        _labelled(
          'Feedback (optional)',
          TextField(
            key: const Key('review-feedback'),
            controller: _feedback,
            enabled: _editable,
            minLines: 3,
            maxLines: 5,
            maxLength: 2000,
            decoration: _box('Add feedback for this staff member…'),
          ),
        ),
        if (_savedBy != null)
          Text(
            'Last saved by $_savedBy.',
            style: const TextStyle(fontSize: 12, color: ReportTokens.muted),
          ),
        if (_error != null) ...[
          const SizedBox(height: 12),
          ScheduleMessageCard(title: _error!, kind: ScheduleMessageKind.error),
        ],
      ],
    );
  }
}

/// What the server currently holds for this seat (refreshed after every confirmed save), with its review state.
class _RecordedAttendance extends StatelessWidget {
  const _RecordedAttendance({required this.row, required this.finalised});
  final ShiftReportStaffRow row;
  final bool finalised;

  @override
  Widget build(BuildContext context) {
    final (label, tone) = staffReportBadge(
      row,
      ended: true,
      finalised: finalised,
    );
    final missingOut =
        !row.isNoShow &&
        !row.isOpen &&
        row.clockInAt != null &&
        row.clockOutAt == null;
    String at(DateTime? d) =>
        d == null ? '—' : DateFormat('HH:mm').format(d.toLocal());
    return ReportCard(
      key: const Key('recorded-attendance'),
      padding: const EdgeInsets.fromLTRB(18, 14, 18, 12),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Badge on its own line: "Corrected · Awaiting review" must never be truncated on a small phone.
          const Text(
            'Recorded attendance',
            style: TextStyle(
              fontSize: 15,
              fontWeight: FontWeight.w600,
              color: ReportTokens.ink,
            ),
          ),
          const SizedBox(height: 8),
          ReportBadge(label, tone),
          const SizedBox(height: 10),
          ReportField('Clock in', at(row.clockInAt)),
          ReportField(
            'Clock out',
            row.clockOutAt != null
                ? at(row.clockOutAt)
                : (missingOut ? 'Missing' : '—'),
            valueColor: missingOut ? ReportTokens.missing : null,
          ),
          ReportField(
            'Break',
            '${row.breakMinutes ?? row.scheduledBreakMinutes} min',
          ),
          ReportField('Worked', workedLabel(row)),
          if (row.attendanceReviewed)
            ReportField(
              'Reviewed by',
              row.attendanceReviewedByName ?? 'Manager',
            ),
        ],
      ),
    );
  }
}

class _RatingBox extends StatelessWidget {
  const _RatingBox({
    super.key,
    required this.value,
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final int value;
  final String label;
  final bool selected;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    label: '$label $value of 5',
    child: GestureDetector(
      onTap: onTap,
      child: Container(
        width: 34,
        height: 34,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          color: selected ? ReportTokens.navy : Colors.white,
          borderRadius: BorderRadius.circular(8),
          border: Border.all(
            color: selected ? ReportTokens.navy : ReportTokens.divider,
          ),
        ),
        child: Text(
          '$value',
          style: TextStyle(
            fontSize: 15,
            fontWeight: FontWeight.w600,
            color: selected ? Colors.white : ReportTokens.muted,
          ),
        ),
      ),
    ),
  );
}

Widget _labelled(String label, Widget child) => Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    Text(
      label,
      style: const TextStyle(fontSize: 13, color: ReportTokens.muted),
    ),
    const SizedBox(height: 6),
    child,
  ],
);

InputDecoration _box(String hint) => InputDecoration(
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

Widget _pickBox({
  Key? key,
  required String text,
  bool placeholder = false,
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
      height: 52,
      alignment: Alignment.centerLeft,
      padding: const EdgeInsets.symmetric(horizontal: 14),
      child: Text(
        text,
        style: TextStyle(
          fontSize: 15,
          color: placeholder ? ReportTokens.muted : ReportTokens.ink,
        ),
      ),
    ),
  ),
);
