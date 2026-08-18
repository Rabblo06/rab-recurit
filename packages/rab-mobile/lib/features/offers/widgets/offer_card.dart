import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../../core/models/offer.dart';
import '../../../core/theme/money.dart';
import '../../../core/theme/tokens.dart';

const _statusLabel = {
  'pending': 'New offer',
  'staff_accepted': 'Awaiting confirmation',
  'manager_confirmed': 'Confirmed',
  'manager_rejected': 'Not confirmed',
  'declined': 'Declined',
  'expired': 'Expired',
  'withdrawn': 'Withdrawn',
};

class OfferCard extends StatelessWidget {
  const OfferCard({
    super.key,
    required this.offer,
    this.onAccept,
    this.onDecline,
    this.accepting = false,
    this.declining = false,
    this.errorMessage,
  });

  final OfferSummary offer;
  final VoidCallback? onAccept;
  final VoidCallback? onDecline;
  final bool accepting;
  final bool declining;
  final String? errorMessage;

  @override
  Widget build(BuildContext context) {
    final tint = AppColors.forStatus(offer.status);
    final dateFmt = DateFormat('d MMM');
    final timeFmt = DateFormat('HH:mm');

    return Container(
      margin: const EdgeInsets.only(bottom: AppSpace.s4),
      padding: const EdgeInsets.all(AppSpace.s5),
      decoration: BoxDecoration(
        color: AppColors.bgSurface,
        borderRadius: BorderRadius.circular(AppRadius.md),
        border: Border.all(color: AppColors.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                (_statusLabel[offer.status] ?? offer.status).toUpperCase(),
                style: AppText.label.copyWith(color: tint, fontWeight: FontWeight.w700, letterSpacing: 0.4),
              ),
              Text(formatPence(offer.estimatedPayPence), style: AppText.label.copyWith(fontWeight: FontWeight.w600)),
            ],
          ),
          const SizedBox(height: AppSpace.s2),
          Text(offer.venueName, style: AppText.section),
          const SizedBox(height: AppSpace.s1),
          Text(offer.roleName, style: AppText.bodyMobile.copyWith(color: AppColors.textSecondary)),
          const SizedBox(height: AppSpace.s3),
          Row(
            children: [
              Text(dateFmt.format(offer.startsAt), style: AppText.label),
              const SizedBox(width: AppSpace.s2),
              Text('·', style: AppText.label.copyWith(color: AppColors.textTertiary)),
              const SizedBox(width: AppSpace.s2),
              Text('${timeFmt.format(offer.startsAt)}–${timeFmt.format(offer.endsAt)}', style: AppText.label),
            ],
          ),
          if (_helperText != null) ...[
            const SizedBox(height: AppSpace.s3),
            Text(_helperText!, style: AppText.label.copyWith(color: _helperColor)),
          ],
          if (errorMessage != null) ...[
            const SizedBox(height: AppSpace.s3),
            Text(errorMessage!, style: AppText.label.copyWith(color: AppColors.danger)),
          ],
          if (offer.status == 'pending') ...[
            const SizedBox(height: AppSpace.s5),
            Row(
              children: [
                Expanded(
                  child: SizedBox(
                    height: 44,
                    child: OutlinedButton(
                      style: OutlinedButton.styleFrom(
                        backgroundColor: AppColors.bgApp,
                        side: const BorderSide(color: AppColors.border),
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                      ),
                      onPressed: (accepting || declining) ? null : onDecline,
                      child: declining
                          ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))
                          : Text('Decline', style: AppText.bodyMobile.copyWith(fontWeight: FontWeight.w600)),
                    ),
                  ),
                ),
                const SizedBox(width: AppSpace.s3),
                Expanded(
                  child: SizedBox(
                    height: 44,
                    child: FilledButton(
                      style: FilledButton.styleFrom(
                        backgroundColor: AppColors.accent,
                        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(AppRadius.sm)),
                      ),
                      onPressed: (accepting || declining) ? null : onAccept,
                      child: accepting
                          ? const SizedBox(
                              width: 18,
                              height: 18,
                              child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                            )
                          : Text('Accept offer', style: AppText.bodyMobile.copyWith(color: Colors.white, fontWeight: FontWeight.w600)),
                    ),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }

  String? get _helperText {
    switch (offer.status) {
      case 'staff_accepted':
        return 'Your acceptance has been sent to the manager. Your shift is not confirmed yet.';
      case 'manager_confirmed':
        return 'Shift confirmed ✓';
      case 'manager_rejected':
        return 'The manager was unable to confirm this shift.${offer.rejectionReason != null ? ' ${offer.rejectionReason}' : ''}';
      case 'declined':
        return 'You declined this offer.';
      case 'expired':
        return 'This offer expired before you responded.';
      case 'withdrawn':
        return 'The manager withdrew this offer.';
      default:
        return null;
    }
  }

  Color get _helperColor => offer.status == 'manager_confirmed' ? AppColors.accent : AppColors.textSecondary;
}
