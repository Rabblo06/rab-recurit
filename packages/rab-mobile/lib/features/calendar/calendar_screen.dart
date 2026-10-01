import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../navigation/app_shell.dart';
import '../home/attendance_provider.dart';
import '../offers/offers_provider.dart';
import '../offers/schedule_offer_detail_screen.dart';
import 'calendar_presentation.dart';
import 'calendar_view.dart';

/// Staff data adapter; both roles use the shared schedule calendar presentation.
class CalendarScreen extends StatelessWidget {
  const CalendarScreen({super.key});
  @override
  Widget build(BuildContext context) {
    final offers = context.watch<OffersProvider>();
    final attendance = context.watch<AttendanceProvider>();
    return StaffCalendarView(
      now: (offers.trustedNow ?? DateTime.now()).toLocal(),
      loading: offers.isLoading,
      error: offers.loadError,
      onRefresh: offers.refresh,
      onProfile: () => AppShell.of(context)?.goToTab(3),
      items: [
        for (final offer in offers.offers.where(calendarIncludes))
          CalendarItem(
            offer: offer,
            color: ShiftVisualStyle.forShift(offer.shiftId).card,
            status: calendarStatus(
              offer,
              active: attendance.active?.shiftId == offer.shiftId,
              ended: attendance.history.any(
                (a) => a.shiftId == offer.shiftId && a.hasEnded,
              ),
            ),
          ),
      ],
      onOpen: (item) => Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => ScheduleOfferDetailScreen(
            offer: item.offer,
            visualStyle: ShiftVisualStyle.forShift(item.offer.shiftId),
          ),
        ),
      ),
    );
  }
}
