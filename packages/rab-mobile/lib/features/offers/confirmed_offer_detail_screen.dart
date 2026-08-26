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
    final colors = context.colors;
    final text = context.text;
    final dateFmt = DateFormat('EEEE d MMMM yyyy');
    final timeFmt = DateFormat('HH:mm');

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(title: const Text('Confirmed shift')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(AppSpace.s5),
          children: [
            Container(
              padding: const EdgeInsets.all(AppSpace.s5),
              decoration: BoxDecoration(
                color: colors.accentSoft,
                borderRadius: BorderRadius.circular(AppRadius.md),
                border: Border.all(color: colors.accent),
              ),
              child: Row(
                children: [
                  Icon(Icons.check_circle, color: colors.accent),
                  const SizedBox(width: AppSpace.s3),
                  Expanded(
                    child: Text(
                      'Confirmed by manager',
                      style: text.bodyMobile.copyWith(color: colors.accentStrong, fontWeight: FontWeight.w600),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: AppSpace.s6),
            Text(offer.venueName, style: text.pageTitle),
            const SizedBox(height: AppSpace.s1),
            Text(offer.roleName, style: text.bodyMobile.copyWith(color: colors.textSecondary)),
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
    final text = context.text;
    return Padding(
      padding: const EdgeInsets.only(bottom: AppSpace.s4),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 110, child: Text(label, style: text.label)),
          Expanded(child: Text(value, style: text.bodyMobile.copyWith(fontWeight: FontWeight.w500))),
        ],
      ),
    );
  }
}
