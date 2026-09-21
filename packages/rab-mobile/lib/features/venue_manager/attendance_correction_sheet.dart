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
  return showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    builder: (sheetContext) => _CorrectionSheetContent(
      row: row,
      shiftDate: shiftDate,
    ),
  );
}

class _CorrectionSheetContent extends StatefulWidget {
  const _CorrectionSheetContent({required this.row, required this.shiftDate});
  final ShiftReportStaffRow row;
  final DateTime shiftDate;

  @override
  State<_CorrectionSheetContent> createState() => _CorrectionSheetContentState();
}

class _CorrectionSheetContentState extends State<_CorrectionSheetContent> {
  late CorrectableField _field = CorrectableField.clockInAt;
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
      _time = TimeOfDay(hour: existing.hour, minute: existing.minute);
    }
    _breakController.text =
        (widget.row.breakMinutes ?? widget.row.scheduledBreakMinutes).toString();
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
    });
  }

  Future<void> _pickTime() async {
    final picked = await showTimePicker(
      context: context,
      initialTime: _time ?? TimeOfDay.now(),
    );
    if (picked != null) setState(() => _time = picked);
  }

  Future<void> _save() async {
    final reason = _reasonController.text.trim();
    if (reason.length < 10) {
      setState(() => _error = 'Please explain this change in at least 10 characters.');
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
      final combined = DateTime(
        widget.shiftDate.year,
        widget.shiftDate.month,
        widget.shiftDate.day,
        _time!.hour,
        _time!.minute,
      );
      newValue = combined.toUtc().toIso8601String();
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
      if (mounted) Navigator.pop(context, true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: EdgeInsets.fromLTRB(
        24,
        8,
        24,
        24 + MediaQuery.viewInsetsOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('Correct ${widget.row.staffName}\'s attendance', style: ScheduleTokens.heading),
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
            else
              OutlinedButton(
                onPressed: _pickTime,
                child: Text(
                  _time == null
                      ? 'Pick a time'
                      : DateFormat('HH:mm').format(
                          DateTime(2000, 1, 1, _time!.hour, _time!.minute),
                        ),
                ),
              ),
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
              Text(_error!, style: const TextStyle(color: ScheduleTokens.danger)),
            ],
            const SizedBox(height: 20),
            SizedBox(
              width: double.infinity,
              height: 50,
              child: FilledButton(
                onPressed: _saving ? null : _save,
                style: FilledButton.styleFrom(
                  backgroundColor: ScheduleTokens.accent,
                  foregroundColor: Colors.white,
                  shape: const StadiumBorder(),
                ),
                child: _saving
                    ? const SizedBox(
                        width: 18,
                        height: 18,
                        child: CircularProgressIndicator(
                          strokeWidth: 2,
                          color: Colors.white,
                        ),
                      )
                    : const Text('Save correction'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
