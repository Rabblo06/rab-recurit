import '../../core/models/offer.dart';

/// The confirmed offer that is "today's shift" — the only data source
/// mobile has for "my assigned shifts" (there's no separate
/// `GET /shifts/mine`). Shared by `HomeScreen`, `ClockScreen` and the
/// Schedule dashboard so all three derive "today's shift" the same way.
///
/// Matches on the shift's local calendar date OR on the shift's own real
/// [startsAt, endsAt] window containing "now" — the second clause exists so
/// an overnight shift (e.g. starts 23:00 one day, ends 07:00 the next)
/// still counts as "today's shift" after midnight, before the caller has
/// clocked in. A calendar-day-only check would wrongly report no
/// actionable shift for a member of staff already mid-shift, which is what
/// previously showed a false "not available" clock action.
OfferSummary? todaysConfirmedOffer(List<OfferSummary> offers) {
  final now = DateTime.now();
  for (final o in offers) {
    if (o.status != 'manager_confirmed') continue;
    if (o.presentation != null) {
      if (o.presentation!.isToday && o.presentation!.state == 'confirmed') {
        return o;
      }
      continue;
    }
    final local = o.startsAt.toLocal();
    final sameCalendarDay =
        local.year == now.year &&
        local.month == now.month &&
        local.day == now.day;
    final inProgress =
        !now.isBefore(o.startsAt.toLocal()) && now.isBefore(o.endsAt.toLocal());
    if (sameCalendarDay || inProgress) return o;
  }
  return null;
}
