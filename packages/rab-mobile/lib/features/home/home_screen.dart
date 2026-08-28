import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/tokens.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import '../offers/offers_provider.dart';
import '../offers/offers_screen.dart';
import 'attendance_provider.dart';
import 'widgets/live_timer_text.dart';

class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key});

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => context.read<AttendanceProvider>().loadHistory());
  }

  /// The confirmed offer whose shift starts today (local time) — the only
  /// data source mobile has for "my assigned shifts" (there's no separate
  /// `GET /shifts/mine`), same as the rest of this screen already relies on.
  OfferSummary? _todaysConfirmedOffer(List<OfferSummary> offers) {
    final now = DateTime.now();
    for (final o in offers) {
      if (o.status != 'manager_confirmed') continue;
      final local = o.startsAt.toLocal();
      if (local.year == now.year && local.month == now.month && local.day == now.day) return o;
    }
    return null;
  }

  int _weeklyEarningsPence(List<dynamic> history) {
    final now = DateTime.now();
    final startOfWeek = DateTime(now.year, now.month, now.day).subtract(Duration(days: now.weekday - 1));
    var total = 0;
    for (final a in history) {
      if (a.status == 'completed' && a.clockInAt.toLocal().isAfter(startOfWeek)) {
        total += (a.earnedPence as int?) ?? 0;
      }
    }
    return total;
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final user = context.watch<AuthProvider>().user;
    final offersProvider = context.watch<OffersProvider>();
    final attendanceProvider = context.watch<AttendanceProvider>();
    final unread = context.watch<NotificationsProvider>().unreadCount;

    if (offersProvider.isLoading || attendanceProvider.isLoadingActive) {
      return Scaffold(
        backgroundColor: colors.bgApp,
        body: Center(child: CircularProgressIndicator(color: colors.accent)),
      );
    }

    final offers = offersProvider.offers;
    final newOffers = offers.where((o) => o.status == 'pending').length;
    final waiting = offers.where((o) => o.status == 'staff_accepted').length;
    final booked = offers.where((o) => o.status == 'manager_confirmed').length;
    final weeklyEarnings = _weeklyEarningsPence(attendanceProvider.history);
    final todaysOffer = _todaysConfirmedOffer(offers);

    final dateFmt = DateFormat('EEE d MMM');
    final timeFmt = DateFormat('HH:mm');
    final currencyFmt = NumberFormat.currency(locale: 'en_GB', symbol: '£');

    return Scaffold(
      backgroundColor: colors.bgApp,
      body: SafeArea(
        child: RefreshIndicator(
          color: colors.accent,
          onRefresh: () => Future.wait([offersProvider.refresh(), attendanceProvider.refreshActive(), attendanceProvider.loadHistory()]),
          child: ListView(
            padding: const EdgeInsets.all(AppSpace.s5),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text('Good ${_greeting()}', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
                        Text(user?.firstName ?? '—', style: text.screenTitle),
                      ],
                    ),
                  ),
                  IconButton(
                    icon: unread > 0
                        ? Badge(label: Text('$unread'), child: const Icon(Icons.notifications_outlined))
                        : const Icon(Icons.notifications_outlined),
                    onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
                  ),
                  CircleAvatar(
                    radius: 28,
                    backgroundColor: colors.accentSoft,
                    child: Text(_initials(user?.firstName, user?.lastName), style: text.section.copyWith(color: colors.accentStrong)),
                  ),
                ],
              ),
              const SizedBox(height: AppSpace.s5),
              _ClockCard(
                colors: colors,
                text: text,
                attendanceProvider: attendanceProvider,
                todaysOffer: todaysOffer,
                dateFmt: dateFmt,
                timeFmt: timeFmt,
              ),
              const SizedBox(height: AppSpace.s5),
              Text('Summary', style: text.section),
              const SizedBox(height: AppSpace.s3),
              GestureDetector(
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const OffersScreen())),
                child: Row(
                  children: [
                    Expanded(child: _statCard(context, 'New offers', '$newOffers', colors.textPrimary)),
                    const SizedBox(width: AppSpace.s3),
                    Expanded(child: _statCard(context, 'Booked', '$booked', colors.accent)),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.s3),
              Row(
                children: [
                  Expanded(child: _statCard(context, 'Waiting', '$waiting', colors.warning)),
                  const SizedBox(width: AppSpace.s3),
                  Expanded(child: _statCard(context, 'This week', currencyFmt.format(weeklyEarnings / 100), colors.accent)),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statCard(BuildContext context, String label, String value, Color color) {
    final colors = context.colors;
    final text = context.text;
    return Container(
      padding: const EdgeInsets.all(AppSpace.s4),
      decoration: BoxDecoration(
        color: colors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: colors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(label, style: text.label),
          const SizedBox(height: AppSpace.s1),
          Text(value, style: text.metricMobile.copyWith(color: color, fontSize: 22)),
        ],
      ),
    );
  }

  String _greeting() {
    final hour = DateTime.now().hour;
    if (hour < 12) return 'morning';
    if (hour < 18) return 'afternoon';
    return 'evening';
  }

  String _initials(String? first, String? last) {
    final f = (first?.isNotEmpty ?? false) ? first![0] : '';
    final l = (last?.isNotEmpty ?? false) ? last![0] : '';
    return '$f$l'.toUpperCase();
  }
}

/// The 5-state Clock In/Out card: no shift today, assigned-not-clocked-in,
/// clocked-in-live, and (implicitly, once clocked out) back to no-card —
/// see `HomeScreen`'s own doc comment on how "today's shift" is derived.
class _ClockCard extends StatelessWidget {
  const _ClockCard({
    required this.colors,
    required this.text,
    required this.attendanceProvider,
    required this.todaysOffer,
    required this.dateFmt,
    required this.timeFmt,
  });

  final AppColorsX colors;
  final AppTextX text;
  final AttendanceProvider attendanceProvider;
  final OfferSummary? todaysOffer;
  final DateFormat dateFmt;
  final DateFormat timeFmt;

  @override
  Widget build(BuildContext context) {
    final active = attendanceProvider.active;

    // State: clocked in — live timer, real data only.
    if (active != null && active.status == 'active') {
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpace.s6),
        decoration: BoxDecoration(color: colors.accent, borderRadius: BorderRadius.circular(AppRadius.lg)),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text('TIME ON SHIFT', style: text.label.copyWith(color: colors.accentSoft, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
            const SizedBox(height: AppSpace.s2),
            Text('${active.venueName} · ${active.roleName}', style: text.bodyMobile.copyWith(color: Colors.white, fontWeight: FontWeight.w600)),
            const SizedBox(height: AppSpace.s3),
            LiveTimerText(
              clockInAt: active.clockInAt,
              style: text.metricMobile.copyWith(color: Colors.white, fontSize: 34),
            ),
            const SizedBox(height: AppSpace.s4),
            if (attendanceProvider.errorMessage != null) ...[
              Text(attendanceProvider.errorMessage!, style: text.label.copyWith(color: Colors.white)),
              const SizedBox(height: AppSpace.s3),
            ],
            SizedBox(
              width: double.infinity,
              height: 44,
              child: OutlinedButton(
                style: OutlinedButton.styleFrom(
                  backgroundColor: Colors.white,
                  side: BorderSide.none,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                ),
                onPressed: attendanceProvider.isBusy ? null : () => attendanceProvider.clockOut(),
                child: attendanceProvider.isBusy
                    ? SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: colors.accent))
                    : Text('Check out', style: text.bodyMobile.copyWith(color: colors.accent, fontWeight: FontWeight.w700)),
              ),
            ),
          ],
        ),
      );
    }

    // State: assigned today, not yet clocked in.
    if (todaysOffer != null) {
      final offer = todaysOffer!;
      return Container(
        width: double.infinity,
        padding: const EdgeInsets.all(AppSpace.s6),
        decoration: BoxDecoration(
          color: colors.bgSurface,
          borderRadius: BorderRadius.circular(AppRadius.lg),
          border: Border.all(color: colors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text("TODAY'S SHIFT", style: text.label.copyWith(color: colors.textSecondary, fontWeight: FontWeight.w700, letterSpacing: 0.4)),
            const SizedBox(height: AppSpace.s2),
            Text(offer.venueName, style: text.section),
            const SizedBox(height: AppSpace.s1),
            Text(offer.roleName, style: text.bodyMobile.copyWith(color: colors.textSecondary)),
            const SizedBox(height: AppSpace.s2),
            Text(
              '${dateFmt.format(offer.startsAt.toLocal())} · ${timeFmt.format(offer.startsAt.toLocal())}–${timeFmt.format(offer.endsAt.toLocal())}',
              style: text.bodyMobile.copyWith(fontWeight: FontWeight.w600),
            ),
            const SizedBox(height: AppSpace.s4),
            if (attendanceProvider.errorMessage != null) ...[
              Text(attendanceProvider.errorMessage!, style: text.label.copyWith(color: colors.danger)),
              const SizedBox(height: AppSpace.s3),
            ],
            SizedBox(
              width: double.infinity,
              height: 44,
              child: FilledButton(
                style: FilledButton.styleFrom(
                  backgroundColor: colors.accent,
                  shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.full)),
                ),
                onPressed: attendanceProvider.isBusy ? null : () => attendanceProvider.clockIn(offer.shiftId),
                child: attendanceProvider.isBusy
                    ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
                    : Text('Clock in', style: text.bodyMobile.copyWith(color: Colors.white, fontWeight: FontWeight.w600)),
              ),
            ),
          ],
        ),
      );
    }

    // State: no shift today — nothing to clock into, shown honestly.
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(AppSpace.s5),
      decoration: BoxDecoration(
        color: colors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.lg),
        border: Border.all(color: colors.border),
      ),
      child: Text('No shift today.', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
    );
  }
}
