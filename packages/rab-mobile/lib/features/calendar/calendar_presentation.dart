import 'dart:math' as math;
import 'package:flutter/material.dart';
import '../../core/models/offer.dart';
import '../../core/theme/calendar_tokens.dart';
export '../../core/theme/calendar_tokens.dart';

/// Read-only presentation. Server lifecycle fields remain authoritative.
CalendarStatus calendarStatus(
  OfferSummary offer, {
  bool active = false,
  bool ended = false,
}) {
  final state = offer.presentation?.state;
  if (state != null) {
    return switch (state) {
      'confirmed' => CalendarStatus.confirmed,
      'pending' =>
        offer.status == 'staff_accepted'
            ? CalendarStatus.awaiting
            : CalendarStatus.open,
      'live' => CalendarStatus.live,
      'clockedOut' => CalendarStatus.clockedOut,
      'complete' => CalendarStatus.complete,
      'ended' => CalendarStatus.ended,
      'declined' => CalendarStatus.declined,
      'rejected' => CalendarStatus.rejected,
      'expired' => CalendarStatus.expired,
      'cancelled' => CalendarStatus.cancelled,
      _ => CalendarStatus.other,
    };
  }
  if (ended) return CalendarStatus.complete;
  if (active) return CalendarStatus.live;
  return switch (offer.status) {
    'manager_confirmed' => CalendarStatus.confirmed,
    'staff_accepted' => CalendarStatus.awaiting,
    'pending' => CalendarStatus.open,
    _ => CalendarStatus.other,
  };
}

bool calendarIncludes(OfferSummary offer) => const {
  'pending',
  'staff_accepted',
  'manager_confirmed',
}.contains(offer.status);

class CalendarItem {
  const CalendarItem({
    required this.offer,
    required this.status,
    required this.color,
  });
  final OfferSummary offer;
  final CalendarStatus status;
  final Color color;
  // Preserve existing Calendar's local-time interval overlap semantics.
  bool occursOn(DateTime day) =>
      offer.startsAt.toLocal().isBefore(
        DateTime(day.year, day.month, day.day + 1),
      ) &&
      offer.endsAt.toLocal().isAfter(day);
}

List<CalendarItem> calendarItemsOn(List<CalendarItem> items, DateTime day) =>
    items.where((item) => item.occursOn(day)).toList()
      ..sort((a, b) => a.offer.startsAt.compareTo(b.offer.startsAt));

String calendarSummary(List<CalendarItem> items) {
  if (items.isEmpty) return '0 shifts';
  final minutes = items.fold<int>(
    0,
    (sum, item) =>
        sum +
        math.max(
          0,
          item.offer.endsAt.difference(item.offer.startsAt).inMinutes,
        ),
  );
  final hours = minutes / 60;
  final value = hours == hours.roundToDouble()
      ? hours.toStringAsFixed(0)
      : hours.toStringAsFixed(1);
  return '${items.length} ${items.length == 1 ? 'shift' : 'shifts'} \u00b7 $value hours';
}
