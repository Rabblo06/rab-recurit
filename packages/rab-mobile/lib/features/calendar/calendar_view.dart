import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../core/theme/money.dart';
import '../../core/widgets/schedule_calendar.dart';
import 'calendar_presentation.dart';

/// Staff data adapter; shared calendar owns layout, selection and motion.
class StaffCalendarView extends StatelessWidget {
  const StaffCalendarView({
    super.key,
    required this.items,
    required this.now,
    required this.onOpen,
    required this.onProfile,
    required this.onRefresh,
    this.loading = false,
    this.error,
  });
  final List<CalendarItem> items;
  final DateTime now;
  final ValueChanged<CalendarItem> onOpen;
  final VoidCallback onProfile;
  final Future<void> Function() onRefresh;
  final bool loading;
  final String? error;
  @override
  Widget build(BuildContext context) => ScheduleCalendar(
    agendaStyle: true,
    now: now,
    loading: loading,
    error: error,
    onProfile: onProfile,
    onRefresh: onRefresh,
    emptyTitle: 'No shifts scheduled',
    emptyMessage: 'Your confirmed shifts and open offers will appear here.',
    entries: [
      for (final item in items)
        ScheduleCalendarEntry(
          id: item.offer.id,
          start: item.offer.startsAt,
          end: item.offer.endsAt,
          status: item.status,
          builder: (_) => CalendarShiftCard(
            key: ValueKey('calendar-shift-${item.offer.id}'),
            item: item,
            onOpen: () => onOpen(item),
          ),
        ),
    ],
  );
}

class CalendarShiftCard extends StatelessWidget {
  const CalendarShiftCard({
    super.key,
    required this.item,
    required this.onOpen,
  });
  final CalendarItem item;
  final VoidCallback onOpen;
  @override
  Widget build(BuildContext context) {
    final offer = item.offer;
    final start = offer.startsAt.toLocal();
    final end = offer.endsAt.toLocal();
    final nextDay = DateUtils.isSameDay(start, end)
        ? ''
        : ' (+${DateUtils.dateOnly(end).difference(DateUtils.dateOnly(start)).inDays}d)';
    return Semantics(
      button: true,
      label: 'View ${offer.roleName} details, ${item.status.label}',
      child: Material(
        color: item.color,
        borderRadius: BorderRadius.circular(21),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onOpen,
          child: IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Container(width: 5, color: item.status.dot),
                Expanded(
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: Text(
                                offer.roleName,
                                maxLines: 2,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 18,
                                  fontWeight: FontWeight.w700,
                                  color: CalendarTokens.ink,
                                ),
                              ),
                            ),
                            const SizedBox(width: 8),
                            Container(
                              width: 30,
                              height: 30,
                              decoration: const BoxDecoration(
                                color: Colors.white,
                                shape: BoxShape.circle,
                              ),
                              child: const Icon(Icons.north_east, size: 16),
                            ),
                          ],
                        ),
                        const SizedBox(height: 6),
                        Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    offer.venueName,
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 13,
                                      fontWeight: FontWeight.w600,
                                      color: CalendarTokens.ink,
                                    ),
                                  ),
                                  if (offer.venueAddress?.trim().isNotEmpty ==
                                      true)
                                    _meta(
                                      Icons.location_on_outlined,
                                      offer.venueAddress!,
                                    ),
                                  _meta(
                                    Icons.schedule,
                                    '${DateFormat('HH:mm').format(start)} \u2013 ${DateFormat('HH:mm').format(end)}$nextDay',
                                  ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 8),
                            Column(
                              crossAxisAlignment: CrossAxisAlignment.end,
                              children: [
                                const Text(
                                  'Pay rate',
                                  style: TextStyle(
                                    fontSize: 10,
                                    color: CalendarTokens.muted,
                                  ),
                                ),
                                Text(
                                  '${formatPence(offer.payRatePence)}/h',
                                  style: const TextStyle(
                                    fontSize: 12,
                                    fontWeight: FontWeight.w700,
                                    color: CalendarTokens.ink,
                                  ),
                                ),
                              ],
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _meta(IconData icon, String text) => Padding(
    padding: const EdgeInsets.only(top: 3),
    child: Row(
      children: [
        Icon(icon, size: 12, color: CalendarTokens.muted),
        const SizedBox(width: 4),
        Expanded(
          child: Text(
            text,
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: const TextStyle(fontSize: 11, color: CalendarTokens.muted),
          ),
        ),
      ],
    ),
  );
}
