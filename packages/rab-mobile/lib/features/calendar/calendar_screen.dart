import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/models/offer.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/empty_state.dart';
import '../home/attendance_provider.dart';
import '../offers/offers_provider.dart';

/// Real assigned-shift data, sourced from `OffersProvider`'s confirmed
/// offers (mobile's only source of "my shifts" — there's no separate `GET
/// /shifts/mine`) plus `AttendanceProvider`'s active/history state for a
/// per-day status label. Existing enums only (`Upcoming`/`Clocked In`/
/// `Completed`) — nothing invented.
class CalendarScreen extends StatelessWidget {
  const CalendarScreen({super.key});

  String? _statusFor(OfferSummary offer, AttendanceProvider attendance) {
    if (attendance.active?.shiftId == offer.shiftId) return 'Clocked in';
    final completed = attendance.history.any((a) => a.shiftId == offer.shiftId && a.status == 'completed');
    if (completed) return 'Completed';
    return 'Upcoming';
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final offersProvider = context.watch<OffersProvider>();
    final attendanceProvider = context.watch<AttendanceProvider>();
    final now = DateTime.now();
    final firstOfMonth = DateTime(now.year, now.month, 1);
    final daysInMonth = DateTime(now.year, now.month + 1, 0).day;
    // DateTime.weekday: Monday=1..Sunday=7; grid starts on Sunday.
    final leadingBlanks = firstOfMonth.weekday % 7;

    final shiftsThisMonth = offersProvider.offers
        .where((o) => o.status == 'manager_confirmed')
        .where((o) => o.startsAt.toLocal().year == now.year && o.startsAt.toLocal().month == now.month)
        .toList()
      ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    final shiftDays = shiftsThisMonth.map((o) => o.startsAt.toLocal().day).toSet();

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(title: const Text('Calendar')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpace.s5),
          children: [
            Text(DateFormat('MMMM yyyy').format(now), style: text.section),
            const SizedBox(height: AppSpace.s4),
            Container(
              padding: const EdgeInsets.all(AppSpace.s4),
              decoration: BoxDecoration(
                color: colors.bgSurface,
                borderRadius: BorderRadius.circular(AppRadius.lg),
                border: Border.all(color: colors.border),
              ),
              child: Column(
                children: [
                  Row(
                    children: ['S', 'M', 'T', 'W', 'T', 'F', 'S']
                        .map((d) => Expanded(child: Center(child: Text(d, style: text.label))))
                        .toList(),
                  ),
                  const SizedBox(height: AppSpace.s3),
                  GridView.builder(
                    shrinkWrap: true,
                    physics: const NeverScrollableScrollPhysics(),
                    gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(crossAxisCount: 7),
                    itemCount: leadingBlanks + daysInMonth,
                    itemBuilder: (context, index) {
                      if (index < leadingBlanks) return const SizedBox.shrink();
                      final day = index - leadingBlanks + 1;
                      final isToday = day == now.day;
                      final hasShift = shiftDays.contains(day);
                      return Column(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Container(
                            width: 32,
                            height: 32,
                            decoration: BoxDecoration(
                              color: isToday ? colors.gold : Colors.transparent,
                              shape: BoxShape.circle,
                            ),
                            alignment: Alignment.center,
                            child: Text(
                              '$day',
                              style: text.bodyMobile.copyWith(
                                color: isToday ? Colors.white : colors.textPrimary,
                                fontWeight: isToday ? FontWeight.w700 : FontWeight.w400,
                              ),
                            ),
                          ),
                          if (hasShift)
                            Container(
                              margin: const EdgeInsets.only(top: 2),
                              width: 5,
                              height: 5,
                              decoration: BoxDecoration(shape: BoxShape.circle, color: colors.accent),
                            ),
                        ],
                      );
                    },
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpace.s5),
            if (shiftsThisMonth.isEmpty)
              const EmptyState(icon: Icons.event_busy_outlined, title: 'No shifts this month', message: 'Confirmed shifts will show up here.')
            else ...[
              Text('This month', style: text.section),
              const SizedBox(height: AppSpace.s3),
              ...shiftsThisMonth.map((offer) => _ShiftRow(offer: offer, status: _statusFor(offer, attendanceProvider), colors: colors, text: text)),
            ],
          ],
        ),
      ),
    );
  }
}

class _ShiftRow extends StatelessWidget {
  const _ShiftRow({required this.offer, required this.status, required this.colors, required this.text});

  final OfferSummary offer;
  final String? status;
  final AppColorsX colors;
  final AppTextX text;

  @override
  Widget build(BuildContext context) {
    final dateFmt = DateFormat('EEE d MMM · HH:mm');
    final statusColor = switch (status) {
      'Completed' => colors.accent,
      'Clocked in' => colors.gold,
      _ => colors.textSecondary,
    };
    return Container(
      margin: const EdgeInsets.only(bottom: AppSpace.s3),
      padding: const EdgeInsets.all(AppSpace.s4),
      decoration: BoxDecoration(
        color: colors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: colors.border),
      ),
      child: Row(
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${offer.venueName} · ${offer.roleName}', style: text.bodyMobile.copyWith(fontWeight: FontWeight.w600)),
                Text(dateFmt.format(offer.startsAt.toLocal()), style: text.label.copyWith(color: colors.textSecondary)),
              ],
            ),
          ),
          if (status != null) Text(status!, style: text.label.copyWith(color: statusColor, fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}
