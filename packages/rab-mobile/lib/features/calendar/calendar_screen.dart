import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/theme/tokens.dart';
import '../../core/widgets/empty_state.dart';

/// Real current-month grid with no shift markers — wiring the assigned-shift
/// data onto this grid is Increment 6. Showing dots/markers now would be
/// fake UI data, so this increment ships the honest chrome plus an explicit
/// empty state instead.
class CalendarScreen extends StatelessWidget {
  const CalendarScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final now = DateTime.now();
    final firstOfMonth = DateTime(now.year, now.month, 1);
    final daysInMonth = DateTime(now.year, now.month + 1, 0).day;
    // DateTime.weekday: Monday=1..Sunday=7; grid starts on Sunday.
    final leadingBlanks = firstOfMonth.weekday % 7;

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
                      return Center(
                        child: Container(
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
                      );
                    },
                  ),
                ],
              ),
            ),
            const EmptyState(
              icon: Icons.event_busy_outlined,
              title: 'Not connected yet',
              message: "Shift calendar isn't connected yet.",
            ),
          ],
        ),
      ),
    );
  }
}
