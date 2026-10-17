import 'dart:async';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/attendance.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
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
          padding: const EdgeInsets.fromLTRB(28, 24, 28, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                minutes == 0
                    ? 'You can clock in now'
                    : 'Your shift hasn’t started yet!',
                textAlign: TextAlign.center,
                style: ScheduleTokens.heading.copyWith(
                  fontSize: 20,
                  color: Colors.black,
                ),
              ),
              const SizedBox(height: 30),
              Text(
                minutes == null
                    ? 'Checking when you can clock in…'
                    : minutes == 0
                    ? 'Go back and tap Clock in to start.'
                    : 'You can’t clock in just yet. You can clock-in\nin $minutes ${minutes == 1 ? 'minute' : 'minutes'}',
                textAlign: TextAlign.center,
                style: ScheduleTokens.body.copyWith(
                  fontWeight: FontWeight.w600,
                  color: Colors.black,
                ),
              ),
              const SizedBox(height: 46),
              SizedBox(
                width: double.infinity,
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: ScheduleTokens.ink,
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 48),
                    shape: const StadiumBorder(),
                  ),
                  onPressed: () => Navigator.pop(context),
                  child: const Text('Back'),
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Feature surfaces only. Shift identity colours elsewhere remain unchanged.
abstract final class ClockPalette {
  static const navy = Color(0xFF0D1B33);
  static const mint = Color(0xFFE5F5EE);
  static const green = Color(0xFF087B5D);
  static const pink = Color(0xFFF8E8E8);
  static const red = Color(0xFFAD2525);
  static const gradient = LinearGradient(
    begin: Alignment.topCenter,
    end: Alignment.bottomCenter,
    colors: [Color(0xFFFFFCF2), Color(0xFFFFD858)],
  );
}

class ClockHeader extends StatelessWidget {
  const ClockHeader({super.key, required this.title, this.scanner = false});
  final String title;
  final bool scanner;
  @override
  Widget build(BuildContext context) => Row(
    children: [
      SizedBox(
        width: 48,
        height: 48,
        child: IconButton(
          tooltip: 'Back',
          onPressed: () => Navigator.maybePop(context),
          icon: Container(
            width: 32,
            height: 32,
            decoration: BoxDecoration(
              color: scanner ? Colors.transparent : Colors.white,
              shape: BoxShape.circle,
            ),
            child: const Icon(Icons.chevron_left, size: 18),
          ),
        ),
      ),
      Expanded(
        child: Text(
          title,
          textAlign: TextAlign.center,
          style: ScheduleTokens.body.copyWith(
            fontSize: scanner ? 10 : 14,
            fontWeight: FontWeight.w500,
          ),
        ),
      ),
      const SizedBox(width: 48),
    ],
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
  Widget build(BuildContext context) => AnimatedContainer(
    duration: ShiftMotion.reduced(context)
        ? Duration.zero
        : const Duration(milliseconds: 180),
    padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 7),
    decoration: BoxDecoration(
      color: warning ? ClockPalette.pink : ClockPalette.mint,
      borderRadius: BorderRadius.circular(999),
    ),
    child: AnimatedSwitcher(
      duration: ShiftMotion.reduced(context)
          ? Duration.zero
          : const Duration(milliseconds: 180),
      child: Text(
        label,
        key: ValueKey(label),
        textAlign: TextAlign.center,
        style: ScheduleTokens.body.copyWith(
          fontSize: 10,
          color: warning ? ClockPalette.red : ClockPalette.green,
          fontWeight: FontWeight.w500,
        ),
      ),
    ),
  );
}

/// Only this subtree ticks. No device clock fallback or local attendance state.
class ClockShiftTimer extends StatefulWidget {
  const ClockShiftTimer({
    super.key,
    this.startsAt,
    this.endsAt,
    this.attendance,
    required this.live,
    required this.completed,
    required this.status,
    this.visualStyle = ShiftVisualStyle.yellow,
    this.team = false,
    this.confirmed = false,
    this.isToday = false,
  });
  final DateTime? startsAt, endsAt;
  final AttendanceSummary? attendance;
  final bool live, completed, team, confirmed, isToday;
  final String status;
  final ShiftVisualStyle visualStyle;
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
    final seconds = delta?.inSeconds.clamp(0, 999999999);
    final value = widget.completed
        ? widget.attendance?.workedMinutes == null
              ? '—'
              : '${(widget.attendance!.workedMinutes! ~/ 60).toString().padLeft(2, '0')}:${(widget.attendance!.workedMinutes! % 60).toString().padLeft(2, '0')}'
        : seconds == null
        ? '—'
        : '${seconds ~/ 3600}h ${seconds ~/ 60 % 60}m ${seconds % 60}s';
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
    return Column(
      key: const ValueKey('clock-timer'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.only(left: widget.team ? 0 : 34),
          child: Text(
            label,
            style: ScheduleTokens.label.copyWith(
              fontSize: 8,
              color: widget.team ? Colors.white70 : ScheduleTokens.muted,
              letterSpacing: 0,
            ),
          ),
        ),
        if (!widget.team &&
            widget.startsAt != null &&
            widget.endsAt != null) ...[
          const SizedBox(height: 6),
          Text(
            '${widget.isToday ? 'Today' : DateFormat('EEE d MMM').format(widget.startsAt!.toLocal())} · ${DateFormat('HH:mm').format(widget.startsAt!.toLocal())}–${DateFormat('HH:mm').format(widget.endsAt!.toLocal())}',
            style: ScheduleTokens.label.copyWith(fontSize: 10),
          ),
        ],
        SizedBox(height: widget.team ? 6 : 12),
        Container(
          width: widget.team ? double.infinity : null,
          padding: widget.team
              ? const EdgeInsets.symmetric(horizontal: 12, vertical: 10)
              : EdgeInsets.zero,
          decoration: widget.team
              ? BoxDecoration(
                  color: overdue ? ClockPalette.pink : ClockPalette.mint,
                  borderRadius: BorderRadius.circular(999),
                )
              : null,
          child: FittedBox(
            fit: BoxFit.scaleDown,
            alignment: widget.team ? Alignment.center : Alignment.centerLeft,
            child: Text.rich(
              TextSpan(
                children: !widget.team && !widget.completed && seconds != null
                    ? [
                        TextSpan(text: '${seconds ~/ 3600}h'),
                        TextSpan(
                          text: ' ${seconds ~/ 60 % 60}m:${seconds % 60}s',
                          style: const TextStyle(fontSize: 20),
                        ),
                      ]
                    : [
                        TextSpan(
                          text: widget.team
                              ? value.replaceAll(' ', ' : ')
                              : value,
                        ),
                      ],
              ),
              key: const ValueKey('clock-timer-value'),
              style: TextStyle(
                fontSize: widget.team ? 32 : 44,
                height: 1.1,
                fontWeight: FontWeight.w400,
                fontFeatures: const [FontFeature.tabularFigures()],
                color: widget.team
                    ? overdue
                          ? ClockPalette.red
                          : ClockPalette.green
                    : ScheduleTokens.ink,
              ),
            ),
          ),
        ),
        if (!widget.team) ...[
          const SizedBox(height: 12),
          ClockStatusBadge(
            label: badge,
            warning: soon || overdue || widget.status == 'Shift cancelled',
          ),
        ],
      ],
    );
  }
}
