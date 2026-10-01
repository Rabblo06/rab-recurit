import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../theme/calendar_tokens.dart';
import 'schedule_feedback.dart';
export '../theme/calendar_tokens.dart';

/// Role adapters supply authorized records and their existing details action.
class ScheduleCalendarEntry {
  const ScheduleCalendarEntry({
    required this.id,
    required this.start,
    required this.end,
    required this.builder,
    this.status = CalendarStatus.confirmed,
  });
  final String id;
  final DateTime start, end;
  final WidgetBuilder builder;
  final CalendarStatus status;
}

List<ScheduleCalendarEntry> scheduleEntriesOn(
  List<ScheduleCalendarEntry> entries,
  DateTime day,
) =>
    entries
        .where(
          (e) =>
              e.start.toLocal().isBefore(
                DateTime(day.year, day.month, day.day + 1),
              ) &&
              e.end.toLocal().isAfter(day),
        )
        .toList()
      ..sort((a, b) => a.start.compareTo(b.start));

String scheduleSummary(
  List<ScheduleCalendarEntry> entries, {
  String noun = 'shift',
}) {
  if (entries.isEmpty) return '0 ${noun}s';
  final minutes = entries.fold<int>(
    0,
    (sum, e) => sum + math.max(0, e.end.difference(e.start).inMinutes),
  );
  final hours = minutes / 60;
  final value = hours == hours.roundToDouble()
      ? hours.toStringAsFixed(0)
      : hours.toStringAsFixed(1);
  return '${entries.length} $noun${entries.length == 1 ? '' : 's'} \u00b7 $value ${hours == 1 ? 'hour' : 'hours'}';
}

/// One calendar layout and motion implementation for Staff and Venue Manager.
class ScheduleCalendar extends StatefulWidget {
  const ScheduleCalendar({
    super.key,
    required this.entries,
    required this.emptyTitle,
    this.emptyMessage = 'No venue shifts are scheduled for this date.',
    this.recordNoun = 'shift',
    this.legend = const [CalendarStatus.confirmed, CalendarStatus.open],
    this.now,
    this.onProfile,
    this.onRefresh,
    this.onRetry,
    this.loading = false,
    this.agendaStyle = false,
    this.error,
  });
  final List<ScheduleCalendarEntry> entries;
  final String emptyTitle, emptyMessage, recordNoun;
  final List<CalendarStatus> legend;
  final DateTime? now;
  final VoidCallback? onProfile, onRetry;
  final Future<void> Function()? onRefresh;
  final bool loading;
  final bool agendaStyle;
  final String? error;
  @override
  State<ScheduleCalendar> createState() => _ScheduleCalendarState();
}

class _ScheduleCalendarState extends State<ScheduleCalendar> {
  late DateTime selected = DateUtils.dateOnly((widget.now ?? DateTime.now()));
  late DateTime viewed = DateTime(selected.year, selected.month);
  late bool month = !widget.agendaStyle;
  late DateTime weekStart = DateTime(
    selected.year,
    selected.month,
    selected.day - 3,
  );
  final dayKeys = <String, GlobalKey>{};
  int direction = 1;
  bool get reduced => MediaQuery.disableAnimationsOf(context);
  Duration motion(int ms) => Duration(milliseconds: reduced ? 0 : ms);
  void moveMonth(int delta) {
    final next = DateTime(viewed.year, viewed.month + delta);
    if (next.year < 2020 || next.year > 2100) return;
    setState(() {
      direction = delta;
      viewed = next;
      selected = next;
    });
  }

  Future<void> pickDate() async {
    final date = await showDatePicker(
      context: context,
      initialDate: selected,
      firstDate: DateTime(2020),
      lastDate: DateTime(2100, 12, 31),
    );
    if (date != null && mounted) {
      setState(() {
        direction = date.isBefore(viewed) ? -1 : 1;
        selected = date;
        viewed = DateTime(date.year, date.month);
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final entries = scheduleEntriesOn(widget.entries, selected);
    return Scaffold(
      backgroundColor: CalendarTokens.background,
      body: SafeArea(
        bottom: false,
        child: RefreshIndicator(
          onRefresh: () async {
            if (widget.onRefresh != null) {
              await widget.onRefresh!();
            } else {
              widget.onRetry?.call();
            }
          },
          child: ListView(
            physics: const AlwaysScrollableScrollPhysics(),
            padding: EdgeInsets.fromLTRB(
              widget.agendaStyle ? 16 : 24,
              8,
              widget.agendaStyle ? 16 : 24,
              24,
            ),
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(
                      DateFormat(
                        MediaQuery.textScalerOf(context).scale(14) > 18
                            ? 'MMM yyyy'
                            : 'MMMM yyyy',
                      ).format(viewed),
                      style: TextStyle(
                        fontSize: widget.agendaStyle ? 22 : 27,
                        fontWeight: FontWeight.w700,
                        letterSpacing: -.8,
                        color: CalendarTokens.ink,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  DecoratedBox(
                    decoration: const BoxDecoration(
                      shape: BoxShape.circle,
                      color: Colors.white,
                      boxShadow: CalendarTokens.shadow,
                    ),
                    child: IconButton(
                      tooltip: 'Profile',
                      onPressed: widget.onProfile,
                      icon: const Icon(Icons.person_outline, size: 21),
                      constraints: BoxConstraints.tightFor(
                        width: widget.agendaStyle ? 44 : 48,
                        height: widget.agendaStyle ? 44 : 48,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 14),
              _toggle(),
              const SizedBox(height: 14),
              if (month) ...[
                _calendar(),
                const SizedBox(height: 14),
              ] else if (widget.agendaStyle) ...[
                _weekStrip(),
                const SizedBox(height: 22),
              ],
              if (widget.loading)
                const _CalendarLoading()
              else if (widget.error != null)
                ScheduleMessageCard(
                  title: 'Calendar unavailable',
                  message: 'Could not load your schedule. Please try again.',
                  kind: ScheduleMessageKind.error,
                  actionLabel: 'Retry',
                  onAction: widget.onRefresh ?? widget.onRetry,
                )
              else
                AnimatedSwitcher(
                  duration: motion(200),
                  switchInCurve: Curves.easeOutCubic,
                  layoutBuilder: (current, previous) => Stack(
                    alignment: Alignment.topCenter,
                    children: [
                      ...previous.map(
                        (e) => ExcludeSemantics(child: IgnorePointer(child: e)),
                      ),
                      ?current,
                    ],
                  ),
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: AnimatedBuilder(
                      animation: animation,
                      child: child,
                      builder: (_, child) => Transform.translate(
                        offset: Offset(
                          0,
                          reduced ? 0 : 8 * (1 - animation.value),
                        ),
                        child: child,
                      ),
                    ),
                  ),
                  child: widget.agendaStyle && !month
                      ? _agenda()
                      : _dayContent(entries),
                ),
            ],
          ),
        ),
      ),
    );
  }

  List<DateTime> get weekDays => List.generate(
    7,
    (i) => DateTime(weekStart.year, weekStart.month, weekStart.day + i),
  );

  Widget _weekStrip() => LayoutBuilder(
    builder: (context, constraints) {
      final wideText = MediaQuery.textScalerOf(context).scale(12) > 17;
      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Row(
          key: const ValueKey('calendar-week-strip'),
          children: [
            for (final day in weekDays)
              SizedBox(
                width: wideText ? 56 : math.max(44, constraints.maxWidth / 7),
                child: Semantics(
                  selected: DateUtils.isSameDay(day, selected),
                  button: true,
                  label: DateFormat('EEEE d MMMM yyyy').format(day),
                  child: InkWell(
                    key: ValueKey(
                      'week-day-${DateFormat('yyyy-MM-dd').format(day)}',
                    ),
                    borderRadius: BorderRadius.circular(14),
                    onTap: () async {
                      setState(() {
                        selected = day;
                        viewed = DateTime(day.year, day.month);
                      });
                      final target =
                          dayKeys[day.toIso8601String()]?.currentContext;
                      if (target != null) {
                        await Scrollable.ensureVisible(
                          target,
                          duration: motion(200),
                          alignment: .25,
                        );
                      }
                    },
                    child: ExcludeSemantics(
                      child: Container(
                        margin: const EdgeInsets.symmetric(horizontal: 2),
                        constraints: const BoxConstraints(minHeight: 52),
                        padding: const EdgeInsets.symmetric(vertical: 8),
                        decoration: BoxDecoration(
                          color: DateUtils.isSameDay(day, selected)
                              ? const Color(0xFF0D0D0B)
                              : Colors.transparent,
                          borderRadius: BorderRadius.circular(14),
                        ),
                        child: Column(
                          children: [
                            Text(
                              DateFormat('E').format(day),
                              style: TextStyle(
                                fontSize: 10,
                                color: DateUtils.isSameDay(day, selected)
                                    ? Colors.white
                                    : CalendarTokens.muted,
                              ),
                            ),
                            const SizedBox(height: 3),
                            Text(
                              '${day.day}',
                              style: TextStyle(
                                fontSize: 14,
                                fontWeight: FontWeight.w700,
                                color: DateUtils.isSameDay(day, selected)
                                    ? Colors.white
                                    : CalendarTokens.ink,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      );
    },
  );

  Widget _agenda() => Column(
    key: const ValueKey('venue-week-agenda'),
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      if (weekDays.every(
        (day) => scheduleEntriesOn(widget.entries, day).isEmpty,
      ))
        Padding(
          padding: const EdgeInsets.only(left: 44, bottom: 16),
          child: Text(
            widget.emptyTitle,
            style: const TextStyle(fontSize: 12, color: CalendarTokens.muted),
          ),
        ),
      for (final day in weekDays)
        Padding(
          key: dayKeys.putIfAbsent(day.toIso8601String(), () => GlobalKey()),
          padding: const EdgeInsets.only(bottom: 16),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 40,
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      DateFormat('E').format(day),
                      style: const TextStyle(
                        fontSize: 10,
                        color: CalendarTokens.muted,
                      ),
                    ),
                    Text(
                      '${day.day}',
                      style: const TextStyle(
                        fontSize: 15,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (scheduleEntriesOn(widget.entries, day).isEmpty)
                      const SizedBox(height: 64),
                    for (final item in scheduleEntriesOn(widget.entries, day))
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: item.builder(context),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
    ],
  );

  Widget _toggle() => Container(
    height: 48,
    padding: const EdgeInsets.all(3),
    decoration: const ShapeDecoration(
      color: Colors.white,
      shape: StadiumBorder(),
    ),
    child: LayoutBuilder(
      builder: (context, constraints) => Stack(
        children: [
          AnimatedAlign(
            duration: motion(240),
            curve: Curves.easeOutCubic,
            alignment: month ? Alignment.centerRight : Alignment.centerLeft,
            child: Container(
              width: constraints.maxWidth / 2,
              decoration: const ShapeDecoration(
                color: Color(0xFF0D0D0B),
                shape: StadiumBorder(),
              ),
            ),
          ),
          Row(
            children: [
              for (final isMonth in [false, true])
                Expanded(
                  child: Semantics(
                    selected: month == isMonth,
                    child: TextButton.icon(
                      onPressed: () => setState(() {
                        month = isMonth;
                        if (!isMonth) {
                          selected = DateUtils.dateOnly(
                            (widget.now ?? DateTime.now()),
                          );
                          viewed = DateTime(selected.year, selected.month);
                          weekStart = DateTime(
                            selected.year,
                            selected.month,
                            selected.day - 3,
                          );
                        }
                      }),
                      style: TextButton.styleFrom(
                        foregroundColor: month == isMonth
                            ? Colors.white
                            : CalendarTokens.muted,
                        padding: EdgeInsets.zero,
                        minimumSize: const Size(0, 42),
                      ),
                      icon: Icon(
                        isMonth
                            ? Icons.calendar_month_outlined
                            : Icons.person_outline,
                        size: 15,
                      ),
                      label: Text(
                        isMonth ? 'Month' : 'Today',
                        style: const TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
        ],
      ),
    ),
  );

  Widget _calendar() {
    final firstWeekday = MaterialLocalizations.of(context).firstDayOfWeekIndex;
    final count = DateUtils.getDaysInMonth(viewed.year, viewed.month);
    final offset =
        (DateTime(viewed.year, viewed.month).weekday % 7 - firstWeekday + 7) %
        7;
    final rows = ((offset + count) / 7).ceil();
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    final rowHeight = scale > 1.3 ? 48.0 : 40.0;
    final widthLabels = MaterialLocalizations.of(context).narrowWeekdays;
    return Container(
      key: const ValueKey('month-calendar-card'),
      padding: const EdgeInsets.fromLTRB(12, 6, 12, 10),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(24),
        boxShadow: CalendarTokens.shadow,
      ),
      child: Column(
        children: [
          Row(
            children: [
              Expanded(
                child: TextButton(
                  onPressed: pickDate,
                  style: TextButton.styleFrom(
                    foregroundColor: CalendarTokens.ink,
                    padding: const EdgeInsets.only(left: 2),
                    alignment: Alignment.centerLeft,
                  ),
                  child: Row(
                    children: [
                      Flexible(
                        child: Text(
                          DateFormat(
                            MediaQuery.textScalerOf(context).scale(14) > 18
                                ? 'MMM yyyy'
                                : 'MMMM yyyy',
                          ).format(viewed),
                          style: const TextStyle(
                            fontSize: 15,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      const SizedBox(width: 4),
                      const Icon(Icons.keyboard_arrow_down, size: 13),
                    ],
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Previous month',
                onPressed: viewed.year == 2020 && viewed.month == 1
                    ? null
                    : () => moveMonth(-1),
                icon: const Icon(
                  Icons.chevron_left,
                  size: 18,
                  color: CalendarTokens.muted,
                ),
                constraints: const BoxConstraints.tightFor(
                  width: 40,
                  height: 44,
                ),
              ),
              IconButton(
                tooltip: 'Next month',
                onPressed: viewed.year == 2100 && viewed.month == 12
                    ? null
                    : () => moveMonth(1),
                icon: const Icon(
                  Icons.chevron_right,
                  size: 18,
                  color: CalendarTokens.muted,
                ),
                constraints: const BoxConstraints.tightFor(
                  width: 40,
                  height: 44,
                ),
              ),
            ],
          ),
          SizedBox(
            height: 22,
            child: Row(
              children: [
                for (var i = 0; i < 7; i++)
                  Expanded(
                    child: Center(
                      child: Text(
                        widthLabels[(firstWeekday + i) % 7],
                        style: const TextStyle(
                          fontSize: 11,
                          fontWeight: FontWeight.w500,
                          color: CalendarTokens.muted,
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ),
          AnimatedSwitcher(
            duration: motion(220),
            layoutBuilder: (current, previous) => Stack(
              alignment: Alignment.topCenter,
              children: [
                ...previous.map(
                  (e) => ExcludeSemantics(child: IgnorePointer(child: e)),
                ),
                ?current,
              ],
            ),
            transitionBuilder: (child, animation) => FadeTransition(
              opacity: animation,
              child: AnimatedBuilder(
                animation: animation,
                child: child,
                builder: (_, child) => Transform.translate(
                  offset: Offset(
                    reduced ? 0 : direction * 16 * (1 - animation.value),
                    0,
                  ),
                  child: child,
                ),
              ),
            ),
            child: Column(
              key: ValueKey('month-grid-${viewed.year}-${viewed.month}'),
              children: [
                for (var row = 0; row < rows; row++)
                  SizedBox(
                    height: rowHeight,
                    child: Row(
                      children: [
                        for (var col = 0; col < 7; col++)
                          Expanded(
                            child:
                                row * 7 + col - offset + 1 < 1 ||
                                    row * 7 + col - offset + 1 > count
                                ? const SizedBox.shrink()
                                : _date(
                                    DateTime(
                                      viewed.year,
                                      viewed.month,
                                      row * 7 + col - offset + 1,
                                    ),
                                  ),
                          ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
          const SizedBox(height: 6),
          Wrap(
            alignment: WrapAlignment.center,
            spacing: 16,
            runSpacing: 4,
            children: [
              for (final status in widget.legend)
                _legend(status.dot, status.label),
            ],
          ),
        ],
      ),
    );
  }

  Widget _date(DateTime day) {
    final active = DateUtils.isSameDay(day, selected);
    final today = DateUtils.isSameDay(day, (widget.now ?? DateTime.now()));
    final statuses = scheduleEntriesOn(
      widget.entries,
      day,
    ).map((e) => e.status).toSet().take(3).toList();
    return Semantics(
      selected: active,
      button: true,
      label:
          '${DateFormat('EEEE d MMMM yyyy').format(day)}${today ? ', Today' : ''}${statuses.isEmpty ? '' : ', ${statuses.map((s) => s.label).join(', ')}'}',
      child: InkWell(
        key: ValueKey('calendar-day-${DateFormat('yyyy-MM-dd').format(day)}'),
        borderRadius: BorderRadius.circular(20),
        onTap: () => setState(() => selected = day),
        child: ExcludeSemantics(
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              AnimatedContainer(
                duration: motion(180),
                width: 30,
                height: 30,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  color: active ? CalendarTokens.green : Colors.transparent,
                  border: today && !active
                      ? Border.all(color: CalendarTokens.mint)
                      : null,
                ),
                child: FittedBox(
                  fit: BoxFit.scaleDown,
                  child: Text(
                    '${day.day}',
                    maxLines: 1,
                    style: TextStyle(
                      fontSize: 14,
                      fontWeight: active ? FontWeight.w700 : FontWeight.w400,
                      color: active ? Colors.white : CalendarTokens.ink,
                    ),
                  ),
                ),
              ),
              SizedBox(
                height: 6,
                child: Row(
                  mainAxisAlignment: MainAxisAlignment.center,
                  children: [
                    for (final status in statuses)
                      Padding(
                        padding: const EdgeInsets.symmetric(horizontal: 1.5),
                        child: _dot(
                          status.dot,
                          key: ValueKey('event-dot-${day.day}-${status.name}'),
                        ),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _legend(Color color, String label) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      _dot(color),
      const SizedBox(width: 5),
      Flexible(
        child: Text(
          label,
          style: const TextStyle(fontSize: 10, color: CalendarTokens.muted),
        ),
      ),
    ],
  );

  Widget _dayContent(List<ScheduleCalendarEntry> entries) {
    final statuses = entries.map((e) => e.status).toSet();
    final badge = statuses.length == 1 ? statuses.single.label : null;
    return Column(
      key: ValueKey('selected-day-${selected.toIso8601String()}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        LayoutBuilder(
          builder: (context, constraints) {
            final heading = Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  DateFormat('EEEE, d MMMM').format(selected),
                  style: const TextStyle(
                    fontSize: 16,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    color: CalendarTokens.ink,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  scheduleSummary(entries, noun: widget.recordNoun),
                  style: const TextStyle(
                    fontSize: 11,
                    color: CalendarTokens.muted,
                  ),
                ),
              ],
            );
            final chip = badge == null
                ? const SizedBox.shrink()
                : Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 9,
                      vertical: 5,
                    ),
                    decoration: const ShapeDecoration(
                      color: CalendarTokens.statusBackground,
                      shape: StadiumBorder(),
                    ),
                    child: Text(
                      '\u2022 $badge',
                      style: const TextStyle(
                        fontSize: 10,
                        fontWeight: FontWeight.w600,
                        color: CalendarTokens.green,
                      ),
                    ),
                  );
            if (constraints.maxWidth < 300 ||
                MediaQuery.textScalerOf(context).scale(14) > 18) {
              return Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  heading,
                  if (badge != null) ...[const SizedBox(height: 6), chip],
                ],
              );
            }
            return Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(child: heading),
                const SizedBox(width: 8),
                chip,
              ],
            );
          },
        ),
        const SizedBox(height: 8),
        if (entries.isEmpty)
          Container(
            padding: const EdgeInsets.all(18),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  widget.emptyTitle,
                  style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
                ),
                SizedBox(height: 6),
                Text(
                  widget.emptyMessage,
                  style: TextStyle(fontSize: 12, color: CalendarTokens.muted),
                ),
              ],
            ),
          )
        else
          for (final item in entries)
            Padding(
              padding: const EdgeInsets.only(bottom: 12),
              key: ValueKey('schedule-entry-${item.id}'),
              child: item.builder(context),
            ),
      ],
    );
  }
}

Widget _dot(Color color, {Key? key}) => Container(
  key: key,
  width: 4,
  height: 4,
  decoration: BoxDecoration(color: color, shape: BoxShape.circle),
);

class _CalendarLoading extends StatelessWidget {
  const _CalendarLoading();
  @override
  Widget build(BuildContext context) => Semantics(
    label: 'Loading schedule',
    child: Column(
      children: [
        for (final height in [26.0, 112.0])
          Container(
            height: height,
            margin: const EdgeInsets.only(bottom: 10),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(20),
            ),
          ),
      ],
    ),
  );
}
