import 'package:flutter/material.dart';

import '../theme/schedule_tokens.dart';
import 'venue_photo.dart';

/// Colours of the Teams countdown (staff Teams and Venue Manager Teams).
abstract final class CountdownPalette {
  static const navy = ScheduleTokens.navy;
  static const mint = Color(0xFFE5F5EE);
  static const green = Color(0xFF087B5D);
  static const pink = Color(0xFFF8E8E8);
  static const red = Color(0xFFAD2525);
}

String _two(int value) => value.toString().padLeft(2, '0');

/// Label rule (owner): before the start "Your shift starts in" on a red tint;
/// once started an elapsed label ("Shift in progress", "Time on shift") on
/// mint — never "started in" for a time still in the future.
enum ShiftCountdownPhase { beforeStart, inProgress, onShift, worked, ended }

/// Presentational HOURS / MINUTES / SECONDS panel. [seconds] is computed by
/// the caller from a server-anchored clock; null renders "—" (no device-clock
/// fallback).
class ShiftCountdownPanel extends StatelessWidget {
  const ShiftCountdownPanel({
    super.key,
    required this.heading,
    required this.seconds,
    this.warning = false,
  });

  /// Heading + tint for a phase, in one place.
  factory ShiftCountdownPanel.phase({
    Key? key,
    required ShiftCountdownPhase phase,
    required int? seconds,
  }) => ShiftCountdownPanel(
    key: key,
    heading: switch (phase) {
      ShiftCountdownPhase.beforeStart => 'Your shift starts in',
      ShiftCountdownPhase.inProgress => 'Shift in progress',
      ShiftCountdownPhase.onShift => 'Time on shift',
      ShiftCountdownPhase.worked => 'Time worked',
      ShiftCountdownPhase.ended => 'Shift ended',
    },
    seconds: phase == ShiftCountdownPhase.ended ? null : seconds,
    warning: phase == ShiftCountdownPhase.beforeStart,
  );

  final String heading;
  final int? seconds;
  final bool warning;

  @override
  Widget build(BuildContext context) {
    final value = seconds?.clamp(0, 999999999);
    final h = value == null ? null : value ~/ 3600;
    final m = value == null ? null : value ~/ 60 % 60;
    final s = value == null ? null : value % 60;
    final digits = warning ? CountdownPalette.red : CountdownPalette.green;
    Widget cell(String text, String unit) => Expanded(
      child: Column(
        children: [
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              text,
              style: ScheduleType.timer.copyWith(
                fontSize: 44,
                fontWeight: FontWeight.w600,
                color: digits,
              ),
            ),
          ),
          const SizedBox(height: 2),
          FittedBox(
            fit: BoxFit.scaleDown,
            child: Text(
              unit,
              style: ScheduleType.timerLabel.copyWith(
                color: digits.withValues(alpha: .8),
              ),
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
        color: warning ? CountdownPalette.pink : CountdownPalette.mint,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Semantics(
        label: value == null
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
              if (value == null)
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
}

/// The navy Teams summary card: venue tile + name, "Today · HH:mm – HH:mm",
/// and the countdown panel below.
class ShiftSummaryNavyCard extends StatelessWidget {
  const ShiftSummaryNavyCard({
    super.key,
    required this.venue,
    required this.schedule,
    required this.photoFileId,
    required this.placeholderColor,
    required this.countdown,
  });
  final String venue;
  final String? schedule;
  final String? photoFileId;
  final Color placeholderColor;
  final Widget countdown;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('teams-summary-card'),
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: CountdownPalette.navy,
      borderRadius: BorderRadius.circular(24),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            VenuePhoto(
              fileId: photoFileId,
              size: 44,
              radius: 14,
              iconSize: 22,
              placeholderColor: placeholderColor,
              semanticLabel: '$venue photo',
            ),
            const SizedBox(width: 14),
            Expanded(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    venue,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: ScheduleType.venueTitle.copyWith(
                      color: Colors.white,
                    ),
                  ),
                  if (schedule != null)
                    Text(
                      schedule!,
                      style: ScheduleType.secondary.copyWith(
                        color: Colors.white70,
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
        const SizedBox(height: 16),
        countdown,
      ],
    ),
  );
}
