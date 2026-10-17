import '../../core/widgets/schedule_feedback.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

/// The three fields a Venue Manager may correct — matches
/// `CORRECTABLE_FIELDS`/`CorrectAttendanceDto.field` on the server exactly.
enum CorrectableField { clockInAt, clockOutAt, breakMinutes }

extension on CorrectableField {
  String get wireName => switch (this) {
    CorrectableField.clockInAt => 'clockInAt',
    CorrectableField.clockOutAt => 'clockOutAt',
    CorrectableField.breakMinutes => 'breakMinutes',
  };
  String get label => switch (this) {
    CorrectableField.clockInAt => 'Clock in',
    CorrectableField.clockOutAt => 'Clock out',
    CorrectableField.breakMinutes => 'Break (minutes)',
  };
}

/// Reason-required correction sheet — one field at a time, matching the
/// server's `CorrectAttendanceDto` shape exactly (never a raw PATCH of the
/// whole attendance row). Every save is audited server-side
/// (`AuditAction.ATTENDANCE_CORRECTED`) with the reason attached.
Future<bool?> showAttendanceCorrectionSheet(
  BuildContext context, {
  required ShiftReportStaffRow row,
  required DateTime shiftDate,
}) {
  return showScheduleSheet<bool>(
    context: context,
    isScrollControlled: true,
    isDismissible: false,
    enableDrag: false,
    builder: (sheetContext) =>
        _CorrectionSheetContent(row: row, shiftDate: shiftDate),
  );
}

class _CorrectionSheetContent extends StatefulWidget {
  const _CorrectionSheetContent({required this.row, required this.shiftDate});
  final ShiftReportStaffRow row;
  final DateTime shiftDate;

  @override
  State<_CorrectionSheetContent> createState() =>
      _CorrectionSheetContentState();
}

class _CorrectionSheetContentState extends State<_CorrectionSheetContent> {
  late CorrectableField _field = CorrectableField.clockInAt;
  // A correction is a full date + time: an overnight shift's clock-out is on
  // the next calendar day, so the date is chosen explicitly — never assumed
  // to be the shift's start date, and never silently rolled forward.
  late DateTime _date = _dateOnly(widget.shiftDate);
  TimeOfDay? _time;
  final _breakController = TextEditingController();
  final _reasonController = TextEditingController();
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final existing = widget.row.clockInAt?.toLocal();
    if (existing != null) {
      _date = _dateOnly(existing);
      _time = TimeOfDay(hour: existing.hour, minute: existing.minute);
    }
    _breakController.text =
        (widget.row.breakMinutes ?? widget.row.scheduledBreakMinutes)
            .toString();
  }

  @override
  void dispose() {
    _breakController.dispose();
    _reasonController.dispose();
    super.dispose();
  }

  void _onFieldChanged(CorrectableField field) {
    setState(() {
      _field = field;
      final existing = switch (field) {
        CorrectableField.clockInAt => widget.row.clockInAt?.toLocal(),
        CorrectableField.clockOutAt => widget.row.clockOutAt?.toLocal(),
        CorrectableField.breakMinutes => null,
      };
      _time = existing == null
          ? null
          : TimeOfDay(hour: existing.hour, minute: existing.minute);
      // No recorded clock-out yet: start from the clock-in's day, which the
      // manager moves forward for a shift that ran past midnight.
      _date = _dateOnly(
        existing ?? widget.row.clockInAt?.toLocal() ?? widget.shiftDate,
      );
      _error = null;
    });
  }

  static DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);

  DateTime? get _combined => _time == null
      ? null
      : DateTime(
          _date.year,
          _date.month,
          _date.day,
          _time!.hour,
          _time!.minute,
        );

  /// The recorded counterpart this value must not cross, as a readable
  /// message — the same rule the server enforces (it stays authoritative).
  String? get _orderProblem {
    final value = _combined;
    if (value == null) return null;
    final fmt = DateFormat('EEE d MMM, HH:mm');
    final clockIn = widget.row.clockInAt?.toLocal();
    final clockOut = widget.row.clockOutAt?.toLocal();
    if (_field == CorrectableField.clockOutAt &&
        clockIn != null &&
        value.isBefore(clockIn)) {
      return 'This is before clock in (${fmt.format(clockIn)}). '
          'If they clocked out after midnight, change the date.';
    }
    if (_field == CorrectableField.clockInAt &&
        clockOut != null &&
        value.isAfter(clockOut)) {
      return 'This is after clock out (${fmt.format(clockOut)}). '
          'Check the date.';
    }
    return null;
  }

  Future<void> _pickDate() async {
    final anchor = _dateOnly(widget.shiftDate);
    final picked = await showDatePicker(
      context: context,
      initialDate: _date,
      firstDate: anchor.subtract(const Duration(days: 1)),
      lastDate: anchor.add(const Duration(days: 2)),
    );
    if (picked != null) {
      setState(() {
        _date = _dateOnly(picked);
        _error = null;
      });
    }
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _time ?? TimeOfDay.now(),
    );
    if (picked != null) {
      setState(() {
        _time = picked;
        _error = null;
      });
    }
  }

  Future<void> _save() async {
    if (_saving) return;
    final reason = _reasonController.text.trim();
    if (reason.length < 10) {
      setState(
        () => _error = 'Please explain this change in at least 10 characters.',
      );
      return;
    }
    String newValue;
    if (_field == CorrectableField.breakMinutes) {
      final minutes = int.tryParse(_breakController.text.trim());
      if (minutes == null || minutes < 0) {
        setState(() => _error = 'Enter a whole number of minutes.');
        return;
      }
      newValue = minutes.toString();
    } else {
      if (_time == null) {
        setState(() => _error = 'Pick a time.');
        return;
      }
      final problem = _orderProblem;
      if (problem != null) {
        setState(() => _error = problem);
        return;
      }
      newValue = _combined!.toUtc().toIso8601String();
    }

    setState(() {
      _saving = true;
      _error = null;
    });
    try {
      await context.read<VenueManagerProvider>().correctAttendance(
        widget.row.attendanceId!,
        field: _field.wireName,
        newValue: newValue,
        reason: reason,
      );
      if (mounted) {
        setState(() => _saving = false);
        Navigator.pop(context, true);
      }
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Something went wrong. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: !_saving,
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Correct ${widget.row.staffName}\'s attendance',
            style: ScheduleTokens.heading,
          ),
          const SizedBox(height: 16),
          SegmentedButton<CorrectableField>(
            segments: CorrectableField.values
                .map((f) => ButtonSegment(value: f, label: Text(f.label)))
                .toList(),
            selected: {_field},
            onSelectionChanged: (s) => _onFieldChanged(s.first),
          ),
          const SizedBox(height: 16),
          if (_field == CorrectableField.breakMinutes)
            TextField(
              controller: _breakController,
              keyboardType: TextInputType.number,
              decoration: const InputDecoration(labelText: 'Minutes'),
            )
          else ...[
            Row(
              children: [
                OutlinedButton.icon(
                  key: const Key('correction-date'),
                  onPressed: _pickDate,
                  icon: const Icon(Icons.calendar_today_outlined, size: 16),
                  label: Text(DateFormat('EEE d MMM').format(_date)),
                ),
                const SizedBox(width: 8),
                OutlinedButton.icon(
                  key: const Key('correction-time'),
                  onPressed: _pickTime,
                  icon: const Icon(Icons.schedule, size: 16),
                  label: Text(
                    _time == null
                        ? 'Pick a time'
                        : DateFormat('HH:mm').format(_combined!),
                  ),
                ),
              ],
            ),
            if (_combined != null) ...[
              const SizedBox(height: 8),
              Text(
                '${_field.label} will be saved as '
                '${DateFormat('EEE d MMM yyyy, HH:mm').format(_combined!)}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ],
          ],
          const SizedBox(height: 16),
          TextField(
            controller: _reasonController,
            minLines: 2,
            maxLines: 4,
            decoration: const InputDecoration(
              labelText: 'Reason (required)',
              hintText: 'Why is this correction needed?',
            ),
          ),
          if (_error != null) ...[
            const SizedBox(height: 8),
            ScheduleMessageCard(
              title: _error!,
              kind: ScheduleMessageKind.error,
            ),
          ],
          TextButton(
            onPressed: _saving ? null : () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          const SizedBox(height: ScheduleTokens.sheetActionGap),
          SchedulePrimaryButton(
            label: 'Save correction',
            onPressed: _saving ? null : _save,
            busy: _saving,
          ),
        ],
      ),
    );
  }
}
