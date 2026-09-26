import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../theme/schedule_tokens.dart';
import 'schedule_feedback.dart';

/// Presentation adapter: records and navigation remain owned by each role.
class ScheduleCalendarEntry {
  const ScheduleCalendarEntry({
    required this.id,
    required this.start,
    required this.end,
    required this.builder,
  });
  final String id;
  final DateTime start, end;
  final WidgetBuilder builder;
}

class ScheduleCalendar extends StatefulWidget {
  const ScheduleCalendar({
    super.key,
    required this.entries,
    required this.emptyTitle,
    this.onProfile,
    this.loading = false,
    this.error,
    this.onRetry,
  });
  final List<ScheduleCalendarEntry> entries;
  final String emptyTitle;
  final VoidCallback? onProfile, onRetry;
  final bool loading;
  final String? error;
  @override
  State<ScheduleCalendar> createState() => _ScheduleCalendarState();
}

class _ScheduleCalendarState extends State<ScheduleCalendar> {
  DateTime selected = DateUtils.dateOnly(DateTime.now());
  bool month = false;
  DateTime _day(int offset) =>
      DateTime(selected.year, selected.month, selected.day + offset);
  List<ScheduleCalendarEntry> _on(DateTime day) =>
      widget.entries
          .where(
            (e) =>
                e.start.toLocal().isBefore(
                  DateTime(day.year, day.month, day.day + 1),
                ) &&
                e.end.toLocal().isAfter(day),
          )
          .toList()
        ..sort((a, b) => a.start.compareTo(b.start));

  @override
  Widget build(BuildContext context) {
    final weekStart = _day(1 - selected.weekday);
    final days = List.generate(
      7,
      (i) => DateTime(weekStart.year, weekStart.month, weekStart.day + i),
    );
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        bottom: false,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    DateFormat('MMMM yyyy').format(selected),
                    style: ScheduleTokens.heading.copyWith(fontSize: 24),
                  ),
                ),
                IconButton.filledTonal(
                  tooltip: 'Profile',
                  onPressed: widget.onProfile,
                  style: IconButton.styleFrom(
                    backgroundColor: Colors.white,
                    minimumSize: const Size(48, 48),
                  ),
                  icon: const Icon(Icons.person_outline),
                ),
              ],
            ),
            const SizedBox(height: 16),
            Container(
              padding: const EdgeInsets.all(4),
              decoration: const ShapeDecoration(
                color: Colors.white,
                shape: StadiumBorder(),
              ),
              child: Row(
                children: [
                  _segment(
                    'Today',
                    Icons.person_outline,
                    !month,
                    () => setState(() {
                      selected = DateUtils.dateOnly(DateTime.now());
                      month = false;
                    }),
                  ),
                  _segment(
                    'Month',
                    Icons.calendar_month_outlined,
                    month,
                    () => setState(() => month = true),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 12),
            if (month)
              CalendarDatePicker(
                key: ValueKey('${selected.year}-${selected.month}'),
                initialDate: selected,
                firstDate: DateTime(2020),
                lastDate: DateTime(2100),
                onDisplayedMonthChanged: (date) =>
                    setState(() => selected = date),
                onDateChanged: (date) => setState(() {
                  selected = date;
                  month = false;
                }),
              )
            else ...[
              Row(
                children: [
                  IconButton(
                    tooltip: 'Previous week',
                    onPressed: () => setState(() => selected = _day(-7)),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  Expanded(
                    child: Text(
                      '${DateFormat('d MMM').format(days.first)} – ${DateFormat('d MMM').format(days.last)}',
                      textAlign: TextAlign.center,
                      style: ScheduleTokens.label,
                    ),
                  ),
                  IconButton(
                    tooltip: 'Next week',
                    onPressed: () => setState(() => selected = _day(7)),
                    icon: const Icon(Icons.chevron_right),
                  ),
                ],
              ),
              SingleChildScrollView(
                scrollDirection: Axis.horizontal,
                child: Row(children: [for (final day in days) _date(day)]),
              ),
            ],
            const SizedBox(height: 24),
            if (widget.loading)
              const Center(child: CircularProgressIndicator())
            else if (widget.error != null)
              ScheduleMessageCard(
                title: 'Calendar unavailable',
                message: widget.error,
                kind: ScheduleMessageKind.error,
                actionLabel: 'Retry',
                onAction: widget.onRetry,
              )
            else if (_on(selected).isEmpty && widget.entries.isEmpty)
              ScheduleMessageCard(
                title: widget.emptyTitle,
                message: 'Your confirmed schedule will appear here.',
              )
            else
              for (var offset = 0; offset < (month ? 1 : 7); offset++)
                _agendaDay(_day(offset)),
          ],
        ),
      ),
    );
  }

  Widget _segment(
    String label,
    IconData icon,
    bool active,
    VoidCallback onTap,
  ) => Expanded(
    child: Semantics(
      selected: active,
      child: TextButton.icon(
        style: TextButton.styleFrom(
          backgroundColor: active ? ScheduleTokens.accent : Colors.white,
          foregroundColor: active ? Colors.white : ScheduleTokens.muted,
          minimumSize: const Size(0, 48),
          shape: const StadiumBorder(),
        ),
        onPressed: onTap,
        icon: Icon(icon, size: 18),
        label: Text(label),
      ),
    ),
  );

  Widget _date(DateTime day) {
    final active = DateUtils.isSameDay(day, selected);
    return Semantics(
      selected: active,
      label: DateFormat('EEEE d MMMM yyyy').format(day),
      child: Padding(
        padding: const EdgeInsets.only(right: 2),
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: () => setState(() => selected = day),
          child: Container(
            width: 48,
            padding: const EdgeInsets.symmetric(vertical: 12),
            decoration: BoxDecoration(
              color: active ? ScheduleTokens.accent : Colors.transparent,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              children: [
                Text(
                  DateFormat('EEE').format(day),
                  style: ScheduleTokens.label.copyWith(
                    color: active ? Colors.white : ScheduleTokens.muted,
                  ),
                ),
                const SizedBox(height: 4),
                Text(
                  DateFormat('dd').format(day),
                  style: ScheduleTokens.body.copyWith(
                    fontWeight: FontWeight.w700,
                    color: active ? Colors.white : ScheduleTokens.ink,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _agendaDay(DateTime day) {
    final entries = _on(day);
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(
            width: 40,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  DateFormat('EEE').format(day),
                  style: ScheduleTokens.label,
                ),
                Text(
                  DateFormat('dd').format(day),
                  style: ScheduleTokens.heading,
                ),
              ],
            ),
          ),
          Expanded(
            child: entries.isEmpty
                ? Padding(
                    padding: const EdgeInsets.symmetric(vertical: 16),
                    child: Text(
                      'No scheduled shifts',
                      style: ScheduleTokens.label,
                    ),
                  )
                : Column(
                    children: [
                      for (final entry in entries)
                        Padding(
                          key: ValueKey('${day.toIso8601String()}-${entry.id}'),
                          padding: const EdgeInsets.only(bottom: 12),
                          child: entry.builder(context),
                        ),
                    ],
                  ),
          ),
        ],
      ),
    );
  }
}
