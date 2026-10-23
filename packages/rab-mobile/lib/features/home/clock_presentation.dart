import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/attendance.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/shift_countdown_panel.dart';
import 'attendance_provider.dart';

/// Presentation only: eligibility and the opening instant remain server-owned.
/// [checkIn] words the same sheet for Check In (the window is shared).
class ClockEarlySheet extends StatefulWidget {
  const ClockEarlySheet({
    super.key,
    required this.availableAt,
    this.checkIn = false,
  });
  final DateTime availableAt;
  final bool checkIn;
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
    final verb = widget.checkIn ? 'check in' : 'clock in';
    final hyphen = widget.checkIn ? 'check-in' : 'clock-in';
    final button = widget.checkIn ? 'Check In' : 'Clock in';
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
                    ? 'You can $verb now'
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
                    ? 'Checking when you can $verb…'
                    : minutes == 0
                    ? 'Go back and tap $button to start.'
                    : 'You can’t $verb just yet. You can $hyphen\nin $minutes ${minutes == 1 ? 'minute' : 'minutes'}',
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
  static const navy = CountdownPalette.navy;
  static const mint = CountdownPalette.mint;
  static const green = CountdownPalette.green;
  static const pink = CountdownPalette.pink;
  static const red = CountdownPalette.red;
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
      // Owner rule: red-tinted "Your shift starts in" before the start, an
      // elapsed label on mint once it has started (never "started in").
      final started =
          now != null &&
          widget.startsAt != null &&
          !now.isBefore(widget.startsAt!);
      final phase = widget.completed
          ? ShiftCountdownPhase.worked
          : widget.live
          ? ShiftCountdownPhase.onShift
          : widget.confirmed && started
          ? ShiftCountdownPhase.inProgress
          : widget.confirmed
          ? ShiftCountdownPhase.beforeStart
          : null;
      if (phase == null) {
        return ShiftCountdownPanel(heading: widget.status, seconds: null);
      }
      return ShiftCountdownPanel.phase(phase: phase, seconds: seconds);
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
