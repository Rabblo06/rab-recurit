import 'package:flutter/material.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';

const _navy = Color(0xFF0F172A);
const _weekdays = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

/// "Tuesday and Sunday" — declared days in calendar order (same wording as the web console and the server message).
String formatWeekdayList(Iterable<String> days) {
  final ordered = _weekdays.where(days.contains).toList();
  if (ordered.length <= 1) return ordered.join();
  return '${ordered.sublist(0, ordered.length - 1).join(', ')} and ${ordered.last}';
}

class AvailabilityConflictEntry {
  AvailabilityConflictEntry(
    this.staffProfileId,
    this.staffName,
    this.availableDays,
    this.dates,
    this.weekdays,
  );
  final String staffProfileId;
  final String staffName;
  final List<String> availableDays;
  final List<String> dates;
  final List<String> weekdays;
}

/// The server's `STAFF_AVAILABILITY_CONFLICT` (409): nothing was created. Submitting again with
/// [acknowledgements] lets the request through; a Manager still has to approve it (and acknowledge again).
class AvailabilityConflict {
  AvailabilityConflict(this.totalRecipients, this.entries, this.unknownCount);
  final int totalRecipients;
  final List<AvailabilityConflictEntry> entries;
  final int unknownCount;

  static AvailabilityConflict? fromError(Object error) {
    if (error is! ApiException ||
        error.statusCode != 409 ||
        error.code != 'STAFF_AVAILABILITY_CONFLICT')
      return null;
    final raw = error.body?['conflicts'];
    if (raw is! List) return null;
    final entries = raw.whereType<Map>().map((c) {
      final dates = (c['conflictDates'] as List? ?? const []).whereType<Map>();
      return AvailabilityConflictEntry(
        c['staffProfileId'] as String,
        (c['staffName'] as String?) ?? 'This staff member',
        (c['availableDays'] as List? ?? const []).cast<String>(),
        dates.map((d) => d['date'] as String).toList(),
        dates.map((d) => d['weekday'] as String).toList(),
      );
    }).toList();
    final unknown = error.body?['unknownAvailability'];
    return AvailabilityConflict(
      (error.body?['totalRecipients'] as num?)?.toInt() ?? entries.length,
      entries,
      unknown is List ? unknown.length : 0,
    );
  }

  List<Map<String, dynamic>> get acknowledgements => [
    for (final e in entries)
      {'staffProfileId': e.staffProfileId, 'dates': e.dates},
  ];
}

/// Staff availability warning. Returns true only on an explicit "Submit anyway"; dismissing or Cancel returns false.
Future<bool> confirmAvailabilityConflict(
  BuildContext context,
  AvailabilityConflict conflict,
) async {
  final single = conflict.totalRecipients == 1 && conflict.entries.length == 1
      ? conflict.entries.first
      : null;
  final result = await showScheduleSheet<bool>(
    context: context,
    builder: (sheet) => Column(
      key: const ValueKey('availability-conflict-sheet'),
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const Text(
          'Staff availability warning',
          style: TextStyle(
            fontSize: 20,
            fontWeight: FontWeight.w700,
            color: _navy,
          ),
        ),
        const SizedBox(height: ScheduleTokens.sheetTextGap),
        if (single != null) ...[
          Text(
            '${single.staffName} has marked themselves as unavailable on ${formatWeekdayList(single.weekdays.toSet())}.',
          ),
          const SizedBox(height: 6),
          Text('Available days: ${formatWeekdayList(single.availableDays)}.'),
        ] else ...[
          Text(
            '${conflict.entries.length} of ${conflict.totalRecipients} selected Staff have availability conflicts.',
            style: const TextStyle(fontWeight: FontWeight.w600, color: _navy),
          ),
          const SizedBox(height: 8),
          for (final e in conflict.entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: Text(
                '${e.staffName} — unavailable on ${formatWeekdayList(e.weekdays.toSet())} (${e.dates.join(', ')}). Available days: ${formatWeekdayList(e.availableDays)}.',
              ),
            ),
          if (conflict.unknownCount > 0)
            Text(
              '${conflict.unknownCount} selected ${conflict.unknownCount == 1 ? 'person has' : 'people have'} not provided availability — that is not treated as unavailable.',
              style: const TextStyle(fontStyle: FontStyle.italic),
            ),
        ],
        const SizedBox(height: 6),
        const Text(
          'You can cancel or choose to submit the request anyway. A manager still has to approve it.',
        ),
        const SizedBox(height: 20),
        Row(
          children: [
            Expanded(
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(minimumSize: const Size(0, 48)),
                onPressed: () => Navigator.pop(sheet, false),
                child: const Text('Cancel'),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: _navy,
                  minimumSize: const Size(0, 48),
                ),
                onPressed: () => Navigator.pop(sheet, true),
                child: const Text('Submit anyway'),
              ),
            ),
          ],
        ),
      ],
    ),
  );
  return result == true;
}
