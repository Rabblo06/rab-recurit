import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/models/offer.dart';
import '../../core/theme/tokens.dart';
import 'offers_provider.dart';
import 'widgets/offer_card.dart';

class OffersScreen extends StatelessWidget {
  const OffersScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<OffersProvider>();

    if (provider.isLoading) {
      return const Scaffold(
        backgroundColor: AppColors.bgApp,
        body: Center(child: CircularProgressIndicator(color: AppColors.accent)),
      );
    }

    final pending = provider.offers.where((o) => o.status == 'pending').toList();
    final awaiting = provider.offers.where((o) => o.status == 'staff_accepted').toList();
    final resolved = provider.offers.where((o) => o.status != 'pending' && o.status != 'staff_accepted').toList();

    return Scaffold(
      backgroundColor: AppColors.bgApp,
      body: SafeArea(
        child: RefreshIndicator(
          color: AppColors.accent,
          onRefresh: provider.refresh,
          child: ListView(
            padding: const EdgeInsets.all(AppSpace.s5),
            children: [
              const Text('Offers', style: AppText.pageTitle),
              const SizedBox(height: AppSpace.s5),
              if (provider.offers.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpace.s8),
                  child: Text(
                    'No offers yet. New shift offers from your manager will show up here.',
                    textAlign: TextAlign.center,
                    style: AppText.bodyMobile.copyWith(color: AppColors.textSecondary),
                  ),
                ),
              if (pending.isNotEmpty) ..._section(context, 'New offers', pending, provider),
              if (awaiting.isNotEmpty) ..._section(context, 'Awaiting manager confirmation', awaiting, provider),
              if (resolved.isNotEmpty) ..._section(context, 'History', resolved, provider),
            ],
          ),
        ),
      ),
    );
  }

  List<Widget> _section(BuildContext context, String label, List<OfferSummary> items, OffersProvider provider) {
    return [
      Padding(
        padding: const EdgeInsets.symmetric(vertical: AppSpace.s3),
        child: Text(
          label.toUpperCase(),
          style: AppText.label.copyWith(color: AppColors.textTertiary, fontWeight: FontWeight.w600),
        ),
      ),
      ...items.map(
        (o) => OfferCard(
          offer: o,
          accepting: provider.busyOfferId == o.id && provider.busyAction == 'accept',
          declining: provider.busyOfferId == o.id && provider.busyAction == 'decline',
          errorMessage: provider.errorOfferId == o.id ? provider.errorMessage : null,
          onAccept: () => provider.respond(o.id, 'accept'),
          onDecline: () => provider.respond(o.id, 'decline'),
        ),
      ),
    ];
  }
}
