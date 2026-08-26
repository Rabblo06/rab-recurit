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

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final user = context.watch<AuthProvider>().user;
    final offersProvider = context.watch<OffersProvider>();
    final unread = context.watch<NotificationsProvider>().unreadCount;

    if (offersProvider.isLoading) {
      return Scaffold(
        backgroundColor: colors.bgApp,
        body: Center(child: CircularProgressIndicator(color: colors.accent)),
      );
    }

    final offers = offersProvider.offers;
    final newOffers = offers.where((o) => o.status == 'pending').length;
    final awaitingConfirmation = offers.where((o) => o.status == 'staff_accepted').length;
    final confirmed = offers.where((o) => o.status == 'manager_confirmed' && o.startsAt.isAfter(DateTime.now())).toList()
      ..sort((a, b) => a.startsAt.compareTo(b.startsAt));
    final OfferSummary? nextShift = confirmed.isNotEmpty ? confirmed.first : null;

    final dateFmt = DateFormat('EEE d MMM');
    final timeFmt = DateFormat('HH:mm');

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(
        actions: [
          IconButton(
            icon: unread > 0
                ? Badge(label: Text('$unread'), child: const Icon(Icons.notifications_outlined))
                : const Icon(Icons.notifications_outlined),
            onPressed: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const NotificationsScreen())),
          ),
        ],
      ),
      body: SafeArea(
        child: RefreshIndicator(
          color: colors.accent,
          onRefresh: offersProvider.refresh,
          child: ListView(
            padding: const EdgeInsets.all(AppSpace.s5),
            children: [
              Text('Good ${_greeting()}', style: text.bodyMobile.copyWith(color: colors.textSecondary)),
              Text(user?.firstName ?? '—', style: text.screenTitle),
              const SizedBox(height: AppSpace.s6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpace.s6),
                decoration: BoxDecoration(
                  color: colors.accent,
                  borderRadius: BorderRadius.circular(AppRadius.lg),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'NEXT CONFIRMED SHIFT',
                      style: text.label.copyWith(color: colors.accentSoft, fontWeight: FontWeight.w700, letterSpacing: 0.4),
                    ),
                    const SizedBox(height: AppSpace.s3),
                    if (nextShift != null) ...[
                      Text(nextShift.venueName, style: text.section.copyWith(color: Colors.white)),
                      const SizedBox(height: AppSpace.s1),
                      Text(nextShift.roleName, style: text.bodyMobile.copyWith(color: colors.accentSoft)),
                      const SizedBox(height: AppSpace.s3),
                      Text(
                        '${dateFmt.format(nextShift.startsAt)} · ${timeFmt.format(nextShift.startsAt)}–${timeFmt.format(nextShift.endsAt)}',
                        style: text.bodyMobile.copyWith(color: Colors.white, fontWeight: FontWeight.w600),
                      ),
                    ] else
                      Text('No confirmed shifts yet.', style: text.bodyMobile.copyWith(color: colors.accentSoft)),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.s5),
              GestureDetector(
                onTap: () => Navigator.of(context).push(MaterialPageRoute(builder: (_) => const OffersScreen())),
                child: Row(
                  children: [
                    Expanded(child: _statCard(context, 'New offers', newOffers, colors.textPrimary)),
                    const SizedBox(width: AppSpace.s3),
                    Expanded(child: _statCard(context, 'Awaiting confirmation', awaitingConfirmation, colors.warning)),
                    const SizedBox(width: AppSpace.s3),
                    Expanded(child: _statCard(context, 'Confirmed', confirmed.length, colors.accent)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statCard(BuildContext context, String label, int value, Color color) {
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
        children: [
          Text('$value', style: text.metricMobile.copyWith(color: color)),
          const SizedBox(height: AppSpace.s1),
          Text(label, textAlign: TextAlign.center, style: text.label),
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
}
