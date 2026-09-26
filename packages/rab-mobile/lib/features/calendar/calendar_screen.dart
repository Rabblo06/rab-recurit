import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/theme/money.dart';
import '../../core/widgets/schedule_calendar.dart';
import '../../core/widgets/schedule_record_card.dart';
import '../../navigation/app_shell.dart';
import '../home/attendance_provider.dart';
import '../offers/offers_provider.dart';
import '../offers/schedule_offer_detail_screen.dart';

/// Confirmed offers and server attendance remain the staff schedule's sources.
class CalendarScreen extends StatelessWidget {
  const CalendarScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final offers = context.watch<OffersProvider>();
    final attendance = context.watch<AttendanceProvider>();
    final confirmed =
        offers.offers.where((o) => o.status == 'manager_confirmed').toList()
          ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    return ScheduleCalendar(
      emptyTitle: 'No confirmed shifts',
      loading: offers.isLoading,
      error: offers.loadError,
      onRetry: offers.load,
      onProfile: () => AppShell.of(context)?.goToTab(3),
      entries: [
        for (var i = 0; i < confirmed.length; i++)
          ScheduleCalendarEntry(
            id: confirmed[i].id,
            start: confirmed[i].startsAt,
            end: confirmed[i].endsAt,
            builder: (context) {
              final offer = confirmed[i];
              final status =
                  offer.presentation?.label ??
                      (attendance.history.any(
                        (a) => a.shiftId == offer.shiftId && a.hasEnded,
                      )
                  ? 'Shift completed'
                  : attendance.active?.shiftId == offer.shiftId
                  ? 'Clocked in'
                  : 'Team Member');
              return ScheduleRecordCard(
                title: offer.roleName,
                venue: offer.venueName,
                address: offer.venueAddress,
                color: ShiftVisualStyle.forShift(offer.shiftId).card,
                metricLabel: 'Pay rate',
                metricValue: '${formatPence(offer.payRatePence)}/h',
                teamLabel: status,
                names: [offer.staffName],
                onOpen: () => Navigator.of(context).push(
                  MaterialPageRoute(
                    builder: (_) => ScheduleOfferDetailScreen(
                      offer: offer,
                      visualStyle: ShiftVisualStyle.forShift(offer.shiftId),
                    ),
                  ),
                ),
              );
            },
          ),
      ],
    );
  }
}
