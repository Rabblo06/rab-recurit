import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/shift_pastel_card.dart';
import '../../navigation/app_shell.dart';
import '../home/attendance_provider.dart';
import '../offers/offers_provider.dart';
import '../offers/schedule_offer_detail_screen.dart';
import 'staff_history.dart';

/// Finished shifts and shifts needing attendance attention, sourced from
/// `AttendanceProvider.history` (the real Clock In/Out backend) plus confirmed
/// offers the server reports as ended without any attendance. Nothing here is
/// shown as verified unless the server approved it. `AttendanceProvider` is
/// constructed once per session by `_RootGate`, same lifetime as
/// `OffersProvider`/`NotificationsProvider`.
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key});

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  HistoryFilter _filter = HistoryFilter.all;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback(
      (_) => context.read<AttendanceProvider>().loadHistory(),
    );
  }

  Future<void> _refresh() async {
    await Future.wait([
      context.read<AttendanceProvider>().loadHistory(),
      context.read<OffersProvider>().refresh(),
    ]);
  }

  @override
  Widget build(BuildContext context) {
    final attendance = context.watch<AttendanceProvider>();
    final offers = context.watch<OffersProvider>();
    final rows = buildStaffHistory(
      history: attendance.history,
      offers: offers.offers,
    );
    ShiftVisualStyle.registerGroup(rows.map((row) => row.shiftId));
    final visible = rows.where((row) => row.matches(_filter)).toList();
    final attention = rows.where((row) => row.needsAttention).length;
    final verified = verifiedMinutesThisMonth(
      rows,
      attendance.trustedNow ?? DateTime.now(),
    );
    final loading = attendance.isLoadingHistory && attendance.history.isEmpty;

    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: ScheduleNavHeader(
                title: 'History',
                onBack: () => AppShell.of(context)?.goToTab(0),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                color: ScheduleTokens.accent,
                onRefresh: _refresh,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.fromLTRB(
                    20,
                    8,
                    20,
                    MediaQuery.viewPaddingOf(context).bottom + 110,
                  ),
                  children: [
                    if (attendance.historyLoadError != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 16),
                        child: ScheduleMessageCard(
                          title: 'History unavailable',
                          message: attendance.historyLoadError,
                          kind: ScheduleMessageKind.error,
                          actionLabel: 'Retry',
                          onAction: attendance.loadHistory,
                        ),
                      ),
                    IntrinsicHeight(
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        children: [
                          Expanded(
                            child: _SummaryCard(
                              value: loading ? '—' : _hours(verified),
                              label: 'Verified hours this month',
                            ),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: _SummaryCard(
                              value: loading ? '—' : '$attention',
                              label: attention == 1
                                  ? 'Shift needs attention'
                                  : 'Shifts need attention',
                              warning: attention > 0,
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),
                    SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          for (final (filter, label) in const [
                            (HistoryFilter.all, 'All shifts'),
                            (HistoryFilter.needsAttention, 'Needs attention'),
                            (HistoryFilter.completed, 'Completed'),
                          ])
                            Padding(
                              padding: const EdgeInsets.only(right: 8),
                              child: _FilterChip(
                                label: label,
                                selected: _filter == filter,
                                onTap: () => setState(() => _filter = filter),
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 18),
                    if (loading)
                      const Padding(
                        padding: EdgeInsets.all(40),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    else if (visible.isEmpty &&
                        attendance.historyLoadError == null)
                      _EmptyHistory(filter: _filter)
                    else
                      for (final row in visible)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 16),
                          child: _HistoryCard(
                            entry: row,
                            offer: offers.offers
                                .where((o) => o.shiftId == row.shiftId)
                                .firstOrNull,
                          ),
                        ),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _hours(int minutes) =>
    '${minutes ~/ 60}h ${(minutes % 60).toString().padLeft(2, '0')}m';

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.value,
    required this.label,
    this.warning = false,
  });
  final String value, label;
  final bool warning;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.fromLTRB(16, 16, 12, 16),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: ScheduleTokens.border),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        FittedBox(
          fit: BoxFit.scaleDown,
          alignment: Alignment.centerLeft,
          child: Text(
            value,
            style: ScheduleType.pageTitle.copyWith(
              color: warning ? ScheduleTokens.errorText : ScheduleTokens.ink,
            ),
          ),
        ),
        const SizedBox(height: 4),
        Text(label, style: ScheduleType.caption),
      ],
    ),
  );
}

class _FilterChip extends StatelessWidget {
  const _FilterChip({
    required this.label,
    required this.selected,
    required this.onTap,
  });
  final String label;
  final bool selected;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) => Semantics(
    selected: selected,
    button: true,
    child: Material(
      color: selected ? ScheduleTokens.navy : Colors.white,
      shape: StadiumBorder(
        side: BorderSide(
          color: selected ? ScheduleTokens.navy : ScheduleTokens.border,
        ),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 44),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 10),
            child: Text(
              label,
              style: ScheduleType.badge.copyWith(
                fontSize: 14,
                color: selected ? Colors.white : ScheduleTokens.ink,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _EmptyHistory extends StatelessWidget {
  const _EmptyHistory({required this.filter});
  final HistoryFilter filter;

  @override
  Widget build(BuildContext context) {
    final (title, message) = switch (filter) {
      HistoryFilter.all => (
        'No approved shifts yet',
        'Finished shifts appear here once your payroll has been approved.',
      ),
      HistoryFilter.needsAttention => (
        'Nothing needs attention',
        'Approved shifts with a correction or dispute will show up here.',
      ),
      HistoryFilter.completed => (
        'No approved shifts yet',
        'Finished shifts appear here once your payroll has been approved.',
      ),
    };
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 48, horizontal: 12),
      child: Column(
        children: [
          const Icon(Icons.history, size: 44, color: ScheduleTokens.muted),
          const SizedBox(height: 16),
          Text(
            title,
            textAlign: TextAlign.center,
            style: ScheduleType.cardTitle,
          ),
          const SizedBox(height: 8),
          Text(
            message,
            textAlign: TextAlign.center,
            style: ScheduleType.secondary,
          ),
        ],
      ),
    );
  }
}

class _HistoryCard extends StatelessWidget {
  const _HistoryCard({required this.entry, required this.offer});
  final StaffHistoryEntry entry;
  final OfferSummary? offer;

  Widget _metric(
    String label,
    String value, {
    Color? color,
    bool end = false,
  }) => Column(
    crossAxisAlignment: end ? CrossAxisAlignment.end : CrossAxisAlignment.start,
    children: [
      Text(label, style: ScheduleType.caption),
      const SizedBox(height: 2),
      Text(
        value,
        textAlign: end ? TextAlign.end : TextAlign.start,
        style: ScheduleType.cardTitle.copyWith(
          fontSize: 17,
          color: color ?? ScheduleTokens.ink,
        ),
      ),
    ],
  );

  @override
  Widget build(BuildContext context) {
    final style = ShiftVisualStyle.forShift(entry.shiftId);
    final a = entry.attendance;
    final worked = a.workedMinutes;
    final approvedPay = a.payrollApprovedPence;
    final footer = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Expanded(
              child: _metric(
                'Hours worked',
                worked == null ? '—' : _hours(worked),
              ),
            ),
            Expanded(
              // Approved payroll amount only; never an estimate.
              child: _metric(
                'Earned pay',
                approvedPay == null ? '—' : formatPence(approvedPay),
                end: true,
              ),
            ),
          ],
        ),
        if (entry.attentionMessage != null) ...[
          const SizedBox(height: 12),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
            decoration: BoxDecoration(
              color: ScheduleTokens.dangerSoft,
              borderRadius: BorderRadius.circular(12),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                const Icon(
                  Icons.error_outline,
                  size: 20,
                  color: ScheduleTokens.errorText,
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    entry.attentionMessage!,
                    style: ScheduleType.secondary.copyWith(
                      color: ScheduleTokens.errorText,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ],
      ],
    );
    final current = offer;
    return ShiftPastelCard(
      style: style,
      badge: entry.badge,
      role: entry.role,
      venue: entry.venue,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      venuePhotoFileId: entry.venuePhotoFileId,
      footer: footer,
      onOpen: current == null
          ? null
          : () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ScheduleOfferDetailScreen(
                  offer: current,
                  visualStyle: style,
                ),
              ),
            ),
    );
  }
}
