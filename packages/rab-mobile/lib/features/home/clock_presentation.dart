import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/attendance.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import 'attendance_provider.dart';

/// Presentation only: eligibility and the opening instant remain server-owned.
class ClockEarlySheet extends StatefulWidget {
  const ClockEarlySheet({super.key, required this.availableAt});
  final DateTime availableAt;
  @override
  State<ClockEarlySheet> createState() => _ClockEarlySheetState();
}

class _ClockEarlySheetState extends State<ClockEarlySheet> {
  Timer? _timer;
  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 1), (_) {
      if (mounted) setState(() {});
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final now = context.watch<AttendanceProvider>().trustedNow;
    final minutes = now == null
        ? null
        : (widget.availableAt.difference(now).inSeconds / 60).ceil().clamp(
            0,
            99999,
          );
    return SafeArea(
      top: false,
      child: SingleChildScrollView(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(28, 28, 28, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                minutes == 0
                    ? 'You can clock in now'
                    : 'Your shift hasn’t started yet!',
                textAlign: TextAlign.center,
                style: ScheduleType.cardTitle.copyWith(
                  fontSize: 22,
                  color: Colors.black,
                ),
              ),
              const SizedBox(height: 24),
              Text(
                minutes == null
                    ? 'Checking when you can clock in…'
                    : minutes == 0
                    ? 'Go back and tap Clock in to start.'
                    : 'You can’t clock in just yet. You can clock-in\nin $minutes ${minutes == 1 ? 'minute' : 'minutes'}',
                textAlign: TextAlign.center,
                style: ScheduleType.bodyStrong.copyWith(color: Colors.black),
              ),
              const SizedBox(height: 36),
              SchedulePrimaryButton(
                label: 'Back',
                onPressed: () => Navigator.pop(context),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Feature surfaces only. The shift card itself uses the shift's identity
/// colour (`ShiftVisualStyle`), never a fixed palette.
abstract final class ClockPalette {
  static const navy = ScheduleTokens.navy;
  static const mint = Color(0xFFE5F5EE);
  static const green = Color(0xFF087B5D);
  static const pink = Color(0xFFF8E8E8);
  static const red = Color(0xFFAD2525);
}

/// The scanner and clock screens share the staff navigation header.
class ClockHeader extends StatelessWidget {
  const ClockHeader({super.key, required this.title, this.scanner = false});
  final String title;
  final bool scanner;
  @override
  Widget build(BuildContext context) => ScheduleNavHeader(
    title: title,
    backgroundColor: scanner ? Colors.transparent : Colors.white,
    titleStyle: scanner
        ? ScheduleType.body.copyWith(fontWeight: FontWeight.w500)
        : null,
  );
}

class ClockStatusBadge extends StatelessWidget {
  const ClockStatusBadge({
    super.key,
    required this.label,
    this.warning = false,
  });
  final String label;
  final bool warning;
  @override
  Widget build(BuildContext context) {
    final foreground = warning ? ClockPalette.red : ClockPalette.green;
    return AnimatedContainer(
      duration: ShiftMotion.reduced(context)
          ? Duration.zero
          : const Duration(milliseconds: 180),
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: warning ? ClockPalette.pink : ClockPalette.mint,
        borderRadius: BorderRadius.circular(999),
      ),
      child: AnimatedSwitcher(
        duration: ShiftMotion.reduced(context)
            ? Duration.zero
            : const Duration(milliseconds: 180),
        child: Row(
          key: ValueKey(label),
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(
              warning ? Icons.schedule : Icons.check,
              size: 16,
              color: foreground,
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                label,
                textAlign: TextAlign.center,
                style: ScheduleType.badge.copyWith(color: foreground),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _two(int value) => value.toString().padLeft(2, '0');

/// Only this subtree ticks. No device clock fallback or local attendance state.
/// The hero layout shows HH:MM:SS with tabular digits so the width never
/// jumps; the [team] layout shows separate HOURS / MINUTES / SECONDS cells.
class ClockShiftTimer extends StatefulWidget {
  const ClockShiftTimer({
    super.key,
    this.startsAt,
    this.endsAt,
    this.attendance,
    required this.live,
    required this.completed,
    required this.status,
    this.team = false,
    this.confirmed = false,
    this.isToday = false,
  });
  final DateTime? startsAt, endsAt;
  final AttendanceSummary? attendance;
  final bool live, completed, team, confirmed, isToday;
  final String status;
  @override
  State<ClockShiftTimer> createState() => _ClockShiftTimerState();
}

class _ClockShiftTimerState extends State<ClockShiftTimer> {
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
    final now = context.watch<AttendanceProvider>().trustedNow;
    final overdue =
        widget.confirmed &&
        now != null &&
        widget.startsAt != null &&
        !now.isBefore(widget.startsAt!);
    final delta = widget.live && widget.attendance != null && now != null
        ? now.difference(widget.attendance!.clockInAt)
        : widget.confirmed && now != null && widget.startsAt != null
        ? (overdue
              ? now.difference(widget.startsAt!)
              : widget.startsAt!.difference(now))
        : null;
    final worked = widget.completed ? widget.attendance?.workedMinutes : null;
    final seconds = widget.completed
        ? (worked == null ? null : worked * 60)
        : delta?.inSeconds.clamp(0, 999999999);
    final label = widget.completed
        ? 'COMPLETED'
        : widget.live
        ? 'LIVE SHIFT'
        : overdue
        ? 'CLOCK-IN OVERDUE'
        : widget.confirmed
        ? 'STARTS IN'
        : 'SHIFT STATUS';
    final soon =
        widget.confirmed && !overdue && seconds != null && seconds <= 900;
    final badge = widget.completed
        ? 'Clocked Out'
        : widget.live
        ? 'Clocked In'
        : overdue
        ? 'Clock-in overdue'
        : soon
        ? 'Start in ${(seconds / 60).ceil()}m'
        : widget.status;
    final h = seconds == null ? null : seconds ~/ 3600;
    final m = seconds == null ? null : seconds ~/ 60 % 60;
    final s = seconds == null ? null : seconds % 60;
    final schedule = widget.startsAt != null && widget.endsAt != null
        ? '${widget.isToday ? 'Today' : DateFormat('EEE d MMM').format(widget.startsAt!.toLocal())} · ${DateFormat('HH:mm').format(widget.startsAt!.toLocal())} – ${DateFormat('HH:mm').format(widget.endsAt!.toLocal())}'
        : null;

    if (widget.team) {
      final warning = overdue;
      final heading = widget.completed
          ? 'Time worked'
          : widget.live
          ? 'Time on shift'
          : overdue
          ? 'Clock-in overdue by'
          : widget.confirmed
          ? 'Your shift starts in'
          : widget.status;
      final digits = warning ? ClockPalette.red : ClockPalette.green;
      Widget cell(String value, String unit) => Expanded(
        child: Column(
          children: [
            FittedBox(
              fit: BoxFit.scaleDown,
              child: Text(
                value,
                style: ScheduleType.timer.copyWith(
                  fontSize: 44,
                  fontWeight: FontWeight.w600,
                  color: digits,
                ),
              ),
            ),
            const SizedBox(height: 2),
            Text(
              unit,
              style: ScheduleType.timerLabel.copyWith(
                color: digits.withValues(alpha: .8),
              ),
            ),
          ],
        ),
      );
      return Container(
        key: const ValueKey('clock-timer'),
        width: double.infinity,
        padding: const EdgeInsets.fromLTRB(12, 14, 12, 14),
        decoration: BoxDecoration(
          color: warning ? ClockPalette.pink : ClockPalette.mint,
          borderRadius: BorderRadius.circular(18),
        ),
        child: Semantics(
          label: seconds == null
              ? heading
              : '$heading $h hours $m minutes $s seconds',
          child: ExcludeSemantics(
            child: Column(
              children: [
                Text(
                  heading,
                  textAlign: TextAlign.center,
                  style: ScheduleType.secondary.copyWith(
                    color: ScheduleTokens.ink,
                  ),
                ),
                const SizedBox(height: 6),
                if (seconds == null)
                  Text(
                    '—',
                    key: const ValueKey('clock-timer-value'),
                    style: ScheduleType.timer.copyWith(color: digits),
                  )
                else
                  Row(
                    key: const ValueKey('clock-timer-value'),
                    children: [
                      cell(_two(h!), 'HOURS'),
                      cell(_two(m!), 'MINUTES'),
                      cell(_two(s!), 'SECONDS'),
                    ],
                  ),
              ],
            ),
          ),
        ),
      );
    }

    return Column(
      key: const ValueKey('clock-timer'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: const EdgeInsets.only(left: 34),
          child: Text(label, style: ScheduleType.timerLabel),
        ),
        if (schedule != null) ...[
          const SizedBox(height: 8),
          Text(
            schedule,
            style: ScheduleType.secondary.copyWith(color: ScheduleTokens.ink),
          ),
        ],
        const SizedBox(height: 10),
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text.rich(
            TextSpan(
              children: seconds == null
                  ? const [TextSpan(text: '—')]
                  : [
                      TextSpan(text: _two(h!)),
                      TextSpan(
                        text: ':${_two(m!)}:${_two(s!)}',
                        style: const TextStyle(fontSize: 32),
                      ),
                    ],
            ),
            key: const ValueKey('clock-timer-value'),
            semanticsLabel: seconds == null
                ? 'Not available'
                : '$h hours $m minutes $s seconds',
            style: ScheduleType.timer.copyWith(fontSize: 60),
          ),
        ),
        const SizedBox(height: 14),
        ClockStatusBadge(
          label: badge,
          warning: soon || overdue || widget.status == 'Shift cancelled',
        ),
      ],
    );
  }
}
