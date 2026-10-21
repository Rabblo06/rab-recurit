import '../../core/models/offer.dart';

/// Which confirmed shifts are still "current" for the staff member:
/// upcoming, today's, or live. A shift leaves Confirmed once the server's
/// presentation says it has finished (clocked out, complete, expired) or its
/// scheduled end passed without a live attendance ("ended" — History then
/// shows it as needing attention). A live shift stays even after its
/// scheduled end, because the person is still clocked in.
///
/// Presentation only: it reads the server's own `presentation.state` and never
/// changes an offer, assignment or attendance.
bool isCurrentConfirmed(OfferSummary offer, {DateTime? now}) {
  if (offer.status != 'manager_confirmed') return false;
  final state = offer.presentation?.state;
  if (state != null) return state == 'confirmed' || state == 'live';
  // Older servers without a presentation: fall back to the scheduled end.
  return (now ?? DateTime.now()).isBefore(offer.endsAt);
}

/// Current confirmed shifts: live first, then by scheduled start.
List<OfferSummary> currentConfirmedShifts(
  Iterable<OfferSummary> offers, {
  DateTime? now,
}) {
  final rows = offers.where((o) => isCurrentConfirmed(o, now: now)).toList();
  rows.sort((a, b) {
    final aLive = a.presentation?.state == 'live' ? 0 : 1;
    final bLive = b.presentation?.state == 'live' ? 0 : 1;
    if (aLive != bLive) return aLive - bLive;
    return a.startsAt.compareTo(b.startsAt);
  });
  return rows;
}
