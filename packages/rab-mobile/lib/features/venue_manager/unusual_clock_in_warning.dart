import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';

/// The server's `CLOCK_IN_CONFIRMATION_REQUIRED` (409) from `POST /attendance/:id/correct`: the corrected clock-in is
/// earlier than the staff member's own scheduled start minus CLOCK_IN_EARLY_MINUTES. Nothing was saved. Sending the
/// same correction again with `confirmUnusualClockIn: true` saves it (owner brief 2026-11-15).
class UnusualClockInWarning {
  UnusualClockInWarning(this.earliestAllowed, this.enteredTime);
  final DateTime earliestAllowed;
  final DateTime enteredTime;

  static UnusualClockInWarning? fromError(Object error) {
    if (error is! ApiException ||
        error.statusCode != 409 ||
        error.code != 'CLOCK_IN_CONFIRMATION_REQUIRED') {
      return null;
    }
    final earliest = DateTime.tryParse(
      error.body?['earliestAllowed'] as String? ?? '',
    );
    final entered = DateTime.tryParse(
      error.body?['enteredTime'] as String? ?? '',
    );
    if (earliest == null || entered == null) return null;
    return UnusualClockInWarning(earliest, entered);
  }
}

/// Compact "Unusual clock-in time" confirmation, the same AlertDialog as "Confirm no-show" on the review screen
/// (card-title heading, body text, TextButton + navy FilledButton) with the shared warning icon. Returns true only on
/// an explicit Confirm; Edit, a tap outside or back returns false and leaves the correction form as it was.
Future<bool> confirmUnusualClockIn(
  BuildContext context,
  UnusualClockInWarning warning,
) async {
  // Times only ("08:45", "05:00"); the day is added to both only when they fall on different days, where a bare time
  // would mislead (an entry on the previous evening).
  final sameDay = DateUtils.isSameDay(
    warning.earliestAllowed.toLocal(),
    warning.enteredTime.toLocal(),
  );
  String hm(DateTime d) =>
      DateFormat(sameDay ? 'HH:mm' : 'EEE d MMM, HH:mm').format(d.toLocal());
  Widget line(String label, String value, Key key) => Row(
    key: key,
    children: [
      Expanded(child: Text(label, style: ScheduleType.secondary)),
      Text(value, style: ScheduleType.bodyStrong),
    ],
  );
  final yes = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      key: const Key('unusual-clock-in-dialog'),
      icon: const Icon(
        Icons.warning_amber_rounded,
        color: ScheduleTokens.warningIcon,
      ),
      title: Text('Unusual clock-in time', style: ScheduleType.cardTitle),
      // Scrolls only when it must (very large text on a small phone), like the screen's Reopen no-show dialog; the
      // width cap keeps it a compact dialog on a tablet or wide screen instead of one long line of text.
      content: SingleChildScrollView(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 400),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'This time is earlier than the normal allowance. Please check before continuing.',
                style: ScheduleType.body,
              ),
              const SizedBox(height: 12),
              line(
                'Earliest allowed',
                hm(warning.earliestAllowed),
                const Key('unusual-clock-in-earliest'),
              ),
              const SizedBox(height: 4),
              line(
                'Entered time',
                hm(warning.enteredTime),
                const Key('unusual-clock-in-entered'),
              ),
            ],
          ),
        ),
      ),
      actions: [
        TextButton(
          key: const Key('unusual-clock-in-edit'),
          onPressed: () => Navigator.of(dialog).pop(false),
          child: const Text('Edit'),
        ),
        FilledButton(
          key: const Key('unusual-clock-in-confirm'),
          style: FilledButton.styleFrom(backgroundColor: ScheduleTokens.navy),
          onPressed: () => Navigator.of(dialog).pop(true),
          child: const Text('Confirm'),
        ),
      ],
    ),
  );
  return yes == true;
}
