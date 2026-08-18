import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/auth/auth_provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/tokens.dart';
import '../offers/offers_provider.dart';
import '../../navigation/app_shell.dart';

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AuthProvider>().user;
    final offersProvider = context.watch<OffersProvider>();

    if (offersProvider.isLoading) {
      return const Scaffold(
        backgroundColor: AppColors.bgApp,
        body: Center(child: CircularProgressIndicator(color: AppColors.accent)),
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
      backgroundColor: AppColors.bgApp,
      body: SafeArea(
        child: RefreshIndicator(
          color: AppColors.accent,
          onRefresh: offersProvider.refresh,
          child: ListView(
            padding: const EdgeInsets.all(AppSpace.s5),
            children: [
              Text('Good ${_greeting()}', style: AppText.bodyMobile.copyWith(color: AppColors.textSecondary)),
              Text(user?.firstName ?? '—', style: AppText.screenTitle),
              const SizedBox(height: AppSpace.s6),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(AppSpace.s6),
                decoration: BoxDecoration(
                  color: AppColors.accent,
                  borderRadius: BorderRadius.circular(AppRadius.lg),
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      'NEXT CONFIRMED SHIFT',
                      style: AppText.label.copyWith(color: AppColors.accentSoft, fontWeight: FontWeight.w700, letterSpacing: 0.4),
                    ),
                    const SizedBox(height: AppSpace.s3),
                    if (nextShift != null) ...[
                      Text(nextShift.venueName, style: AppText.section.copyWith(color: Colors.white)),
                      const SizedBox(height: AppSpace.s1),
                      Text(nextShift.roleName, style: AppText.bodyMobile.copyWith(color: AppColors.accentSoft)),
                      const SizedBox(height: AppSpace.s3),
                      Text(
                        '${dateFmt.format(nextShift.startsAt)} · ${timeFmt.format(nextShift.startsAt)}–${timeFmt.format(nextShift.endsAt)}',
                        style: AppText.bodyMobile.copyWith(color: Colors.white, fontWeight: FontWeight.w600),
                      ),
                    ] else
                      Text('No confirmed shifts yet.', style: AppText.bodyMobile.copyWith(color: AppColors.accentSoft)),
                  ],
                ),
              ),
              const SizedBox(height: AppSpace.s5),
              GestureDetector(
                onTap: () => AppShell.of(context)?.goToTab(1),
                child: Row(
                  children: [
                    Expanded(child: _statCard('New offers', newOffers, AppColors.textPrimary)),
                    const SizedBox(width: AppSpace.s3),
                    Expanded(child: _statCard('Awaiting confirmation', awaitingConfirmation, AppColors.warning)),
                    const SizedBox(width: AppSpace.s3),
                    Expanded(child: _statCard('Confirmed', confirmed.length, AppColors.accent)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statCard(String label, int value, Color color) {
    return Container(
      padding: const EdgeInsets.all(AppSpace.s4),
      decoration: BoxDecoration(
        color: AppColors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        children: [
          Text('$value', style: AppText.metricMobile.copyWith(color: color)),
          const SizedBox(height: AppSpace.s1),
          Text(label, textAlign: TextAlign.center, style: AppText.label),
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
