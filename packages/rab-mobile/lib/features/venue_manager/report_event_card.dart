import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import 'sent_shift.dart';
import 'venue_manager_provider.dart';

/// One "Event staffing summaries" card on the Reports screen: status pill +
/// open arrow, role, venue, date/time, then the confirmed/open footer. The
/// whole card opens the shift report ([onTap]); the arrow is a visual cue.
class ReportEventCard extends StatelessWidget {
  ReportEventCard({required this.event, required this.onTap})
    : super(key: ValueKey('report-event-card-${event.id}'));
  final VenueEvent event;
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
    final look = reportEventLook(event.status);
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
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 12,
                        vertical: 5,
                      ),
                      decoration: BoxDecoration(
                        color: look.pill,
                        borderRadius: BorderRadius.circular(999),
                      ),
                      child: Text(
                        look.label,
                        style: TextStyle(
                          fontSize: 13,
                          fontWeight: FontWeight.w500,
                          color: look.pillText,
                        ),
                      ),
                    ),
                    const Spacer(),
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
                  event.role,
                  style: const TextStyle(
                    fontSize: 22,
                    height: 1.2,
                    fontWeight: FontWeight.w700,
                    color: _ink,
                  ),
                ),
                const SizedBox(height: 2),
                Text(
                  event.venue,
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
                      DateFormat('EEE d MMM').format(event.start),
                    ),
                    _meta(Icons.schedule, timeRange(event.start, event.end)),
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
                        '${event.filled} / ${event.required} confirmed · ${event.vacancies} open',
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

  static Widget _meta(IconData icon, String text) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 17, color: _muted),
      const SizedBox(width: 8),
      Text(text, style: const TextStyle(fontSize: 15, color: _muted)),
    ],
  );
}
