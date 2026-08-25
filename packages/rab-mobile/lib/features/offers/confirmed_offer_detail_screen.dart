import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/tokens.dart';

/// Full detail view for a `manager_confirmed` offer — reached by tapping a
/// confirmed `OfferCard`. Shows only fields the backend `OfferSummary`
/// actually returns (venue/role name, times, confirmed-at, rate) — no
/// fabricated address/notes fields the API doesn't provide.
class ConfirmedOfferDetailScreen extends StatelessWidget {
  const ConfirmedOfferDetailScreen({super.key, required this.offer});

  final OfferSummary offer;

  @override
  Widget build(BuildContext context) {
    final dateFmt = DateFormat('EEEE d MMMM yyyy');
    final timeFmt = DateFormat('HH:mm');

    return Scaffold(
      backgroundColor: AppColors.bgApp,
      appBar: AppBar(title: const Text('Confirmed shift')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpace.s5),
          children: [
            Container(
              padding: const EdgeInsets.all(AppSpace.s5),
              decoration: BoxDecoration(
                color: AppColors.accentSoft,
                borderRadius: BorderRadius.circular(AppRadius.md),
                border: Border.all(color: AppColors.accent),
              ),
              child: Row(
                children: [
                  const Icon(Icons.check_circle, color: AppColors.accent),
                  const SizedBox(width: AppSpace.s3),
                  Expanded(
                    child: Text(
                      'Confirmed by manager',
                      style: AppText.bodyMobile.copyWith(color: AppColors.accentStrong, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpace.s6),
            Text(offer.venueName, style: AppText.pageTitle),
            const SizedBox(height: AppSpace.s1),
            Text(offer.roleName, style: AppText.bodyMobile.copyWith(color: AppColors.textSecondary)),
            const SizedBox(height: AppSpace.s6),
            _DetailRow(label: 'Date', value: dateFmt.format(offer.startsAt)),
            _DetailRow(label: 'Time', value: '${timeFmt.format(offer.startsAt)} – ${timeFmt.format(offer.endsAt)}'),
            _DetailRow(label: 'Rate', value: formatPence(offer.estimatedPayPence)),
            if (offer.managerConfirmedAt != null)
              _DetailRow(label: 'Confirmed on', value: DateFormat('d MMM yyyy, HH:mm').format(offer.managerConfirmedAt!)),
          ],
        ),
      ),
    );
  }
}

class _DetailRow extends StatelessWidget {
  const _DetailRow({required this.label, required this.value});

  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.s4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 110, child: Text(label, style: AppText.label)),
          Expanded(child: Text(value, style: AppText.bodyMobile.copyWith(fontWeight: FontWeight.w500))),
        ],
      ),
    );
  }
}
