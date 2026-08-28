import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/models/attendance.dart';
import '../../core/theme/tokens.dart';
import '../../core/widgets/empty_state.dart';
import '../home/attendance_provider.dart';

/// Completed shifts, sourced from `AttendanceProvider.history` — the real
/// Clock In/Out backend, not fake data. `AttendanceProvider` is constructed
/// once per session by `_RootGate`, same lifetime as `OffersProvider`/
/// `NotificationsProvider`.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => context.read<AttendanceProvider>().loadHistory());
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final attendance = context.watch<AttendanceProvider>();
    final dateFmt = DateFormat('EEE d MMM');
    final timeFmt = DateFormat('HH:mm');
    final currencyFmt = NumberFormat.currency(locale: 'en_GB', symbol: '£');

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(title: const Text('History')),
      body: SafeArea(
        child: RefreshIndicator(
          color: colors.accent,
          onRefresh: attendance.loadHistory,
          child: attendance.isLoadingHistory && attendance.history.isEmpty
              ? Center(child: CircularProgressIndicator(color: colors.accent))
              : attendance.history.isEmpty
                  ? ListView(
                      children: const [
                        EmptyState(icon: Icons.history, title: 'No history yet', message: 'Completed shifts will show up here.'),
                      ],
                    )
                  : ListView.separated(
                      padding: const EdgeInsets.all(AppSpace.s5),
                      itemCount: attendance.history.length,
                      separatorBuilder: (_, _) => const SizedBox(height: AppSpace.s3),
                      itemBuilder: (context, index) => _HistoryCard(
                        entry: attendance.history[index],
                        colors: colors,
                        text: text,
                        dateFmt: dateFmt,
                        timeFmt: timeFmt,
                        currencyFmt: currencyFmt,
                      ),
                    ),
        ),
      ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({
    required this.entry,
    required this.colors,
    required this.text,
    required this.dateFmt,
    required this.timeFmt,
    required this.currencyFmt,
  });

  final AttendanceSummary entry;
  final AppColorsX colors;
  final AppTextX text;
  final DateFormat dateFmt;
  final DateFormat timeFmt;
  final NumberFormat currencyFmt;

  @override
  Widget build(BuildContext context) {
    final worked = entry.workedMinutes;
    final workedLabel = worked == null ? '—' : '${worked ~/ 60}h ${worked % 60}m';

    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.s5),
      decoration: BoxDecoration(
        color: colors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(entry.venueName, style: text.section),
                    Text(entry.roleName, style: text.bodyMobile.copyWith(color: colors.textSecondary)),
                  ],
                ),
              ),
              if (entry.earnedPence != null)
                Text(currencyFmt.format(entry.earnedPence! / 100), style: text.bodyMobile.copyWith(color: colors.accent, fontWeight: FontWeight.w700)),
            ],
          ),
          const SizedBox(height: AppSpace.s3),
          Text(dateFmt.format(entry.startsAt.toLocal()), style: text.label),
          const SizedBox(height: AppSpace.s1),
          Text(
            'Scheduled ${timeFmt.format(entry.startsAt.toLocal())}–${timeFmt.format(entry.endsAt.toLocal())}',
            style: text.label.copyWith(color: colors.textSecondary),
          ),
          Text(
            'Actual ${timeFmt.format(entry.clockInAt.toLocal())}'
            '${entry.clockOutAt != null ? '–${timeFmt.format(entry.clockOutAt!.toLocal())}' : ''}'
            ' · $workedLabel worked',
            style: text.label.copyWith(color: colors.textSecondary),
          ),
        ],
      ),
    );
  }
}
