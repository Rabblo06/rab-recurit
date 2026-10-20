import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'sent_shift.dart';
import 'shift_report.dart';

/// One Reports / History card: lifecycle pill (server `displayLabel`) + open arrow, role, venue, date/time, then the
/// confirmed/open footer. A secondary marker shows unresolved attendance or an outstanding obligation; the whole card
/// opens the shift report ([onTap]); the arrow is a visual cue.
class ReportEventCard extends StatelessWidget {
  ReportEventCard({required this.report, required this.onTap})
    : super(key: ValueKey('report-event-card-${report.shiftId}'));
  final ReportSummary report;
  final VoidCallback onTap;

  static const _ink = Color(0xFF0F172A);
  static const _muted = Color(0xFF64748B);

  /// "10:15–20:15", with "(+1)" when the shift ends on a later day.
  static String timeRange(DateTime start, DateTime end) {
    final overnight =
        start.year != end.year ||
        start.month != end.month ||
        start.day != end.day;
    final f = DateFormat('HH:mm');
    return '${f.format(start)}–${f.format(end)}${overnight ? ' (+1)' : ''}';
  }

  @override
  Widget build(BuildContext context) {
    final life = report.lifecycle;
    final look = reportLifecycleLook(life.displayStatus, life.displayLabel);
    final marker = life.needsAttendanceReview
        ? 'Needs attendance review'
        : life.needsAttention
        ? 'Needs attention'
        : null;
    final start = report.startsAt.toLocal(), end = report.endsAt.toLocal();
    final radius = BorderRadius.circular(24);
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Material(
        color: look.card,
        borderRadius: radius,
        child: InkWell(
          borderRadius: radius,
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 18, 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Wrap(
                        spacing: 8,
                        runSpacing: 6,
                        children: [
                          _pill(look.label, look.pill, look.pillText),
                          if (marker != null)
                            _pill(
                              marker,
                              const Color(0xFFFFE4D6),
                              const Color(0xFFB45309),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 8),
                    ExcludeSemantics(
                      child: Container(
                        width: 34,
                        height: 34,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                          boxShadow: [
                            BoxShadow(
                              color: Color(0x14000000),
                              blurRadius: 6,
                              offset: Offset(0, 2),
                            ),
                          ],
                        ),
                        child: const Icon(
                          Icons.north_east,
                          size: 18,
                          color: _ink,
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 12),
                Text(
                  report.roleName,
                  style: const TextStyle(
                    fontSize: 22,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    color: _ink,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  report.venueName,
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w600,
                    color: _muted,
                  ),
                ),
                const SizedBox(height: 14),
                Wrap(
                  spacing: 18,
                  runSpacing: 6,
                  children: [
                    _meta(
                      Icons.calendar_today_outlined,
                      DateFormat('EEE d MMM').format(start),
                    ),
                    _meta(Icons.schedule, timeRange(start, end)),
                  ],
                ),
                const SizedBox(height: 14),
                Divider(height: 1, color: _ink.withValues(alpha: .08)),
                const SizedBox(height: 14),
                Row(
                  children: [
                    Container(width: 1.5, height: 18, color: _muted),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Text(
                        '${report.filledCount} / ${report.requiredCount} confirmed · ${report.open} open',
                        style: const TextStyle(fontSize: 15, color: _muted),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  static Widget _pill(String text, Color bg, Color fg) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 5),
    decoration: BoxDecoration(
      color: bg,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      text,
      style: TextStyle(fontSize: 13, fontWeight: FontWeight.w500, color: fg),
    ),
  );

  static Widget _meta(IconData icon, String text) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 17, color: _muted),
      const SizedBox(width: 8),
      Text(text, style: const TextStyle(fontSize: 15, color: _muted)),
    ],
  );
}
