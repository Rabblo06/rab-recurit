import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/shift_pastel_card.dart';
import '../home/widgets/shift_routes.dart';
import 'offer_response_feedback.dart';
import 'offers_provider.dart';
import 'staff_shift_lifecycle.dart';

/// Both collections read the same authoritative provider; presentation never
/// copies a record into another category or changes its lifecycle.
/// Confirmed lists only current shifts (upcoming, today's, live); finished
/// shifts move to History via [isCurrentConfirmed].
class ScheduleOffersScreen extends StatelessWidget {
  const ScheduleOffersScreen({super.key, this.confirmed = false});
  final bool confirmed;

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<OffersProvider>();
    final items = confirmed
        ? currentConfirmedShifts(provider.offers)
        : (provider.offers
              .where(
                (o) => o.status == 'pending' || o.status == 'staff_accepted',
              )
              .toList()
            ..sort((a, b) => a.startsAt.compareTo(b.startsAt)));
    final title = confirmed ? 'Confirmed' : 'Offers';
    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 8, 12, 4),
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Back',
                    onPressed: () => Navigator.maybePop(context),
                    icon: const Icon(Icons.arrow_back, size: 26),
                  ),
                  const SizedBox(width: 4),
                  Expanded(
                    child: Semantics(
                      header: true,
                      child: Text(title, style: ScheduleType.pageTitle),
                    ),
                  ),
                  IconButton(
                    tooltip: confirmed ? 'Offers' : 'Confirmed',
                    icon: Icon(
                      confirmed ? Icons.work_outline : Icons.event_available,
                    ),
                    onPressed: () => Navigator.of(context).push(
                      MaterialPageRoute<void>(
                        builder: (_) =>
                            ScheduleOffersScreen(confirmed: !confirmed),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: provider.isLoading
                  ? const Center(child: CircularProgressIndicator())
                  : RefreshIndicator(
                      onRefresh: provider.refresh,
                      child: ListView.builder(
                        physics: const AlwaysScrollableScrollPhysics(),
                        padding: EdgeInsets.fromLTRB(
                          16,
                          12,
                          16,
                          MediaQuery.viewPaddingOf(context).bottom + 32,
                        ),
                        itemCount: items.length + 1,
                        itemBuilder: (context, index) {
                          if (index == 0) {
                            if (provider.loadError != null) {
                              return Padding(
                                padding: const EdgeInsets.only(bottom: 16),
                                child: ScheduleMessageCard(
                                  title: 'Shifts unavailable',
                                  message: provider.loadError,
                                  kind: ScheduleMessageKind.error,
                                  actionLabel: 'Retry',
                                  onAction: provider.refresh,
                                ),
                              );
                            }
                            if (items.isEmpty) {
                              return _EmptyList(confirmed: confirmed);
                            }
                            return const SizedBox.shrink();
                          }
                          final offer = items[index - 1];
                          return _PastelOfferCard(
                            key: ValueKey(offer.id),
                            offer: offer,
                            style: ShiftVisualStyle.forShift(offer.shiftId),
                          );
                        },
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}

class _EmptyList extends StatelessWidget {
  const _EmptyList({required this.confirmed});
  final bool confirmed;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 72, horizontal: 24),
    child: Column(
      children: [
        Icon(
          confirmed ? Icons.event_available_outlined : Icons.work_outline,
          size: 44,
          color: ScheduleTokens.muted,
        ),
        const SizedBox(height: 16),
        Text(
          confirmed ? 'No confirmed shifts' : 'No offers right now',
          textAlign: TextAlign.center,
          style: ScheduleType.cardTitle,
        ),
        const SizedBox(height: 8),
        Text(
          confirmed
              ? 'Shifts you accept appear here until they finish. Finished shifts move to History.'
              : 'New shift offers from your venues will appear here.',
          textAlign: TextAlign.center,
          style: ScheduleType.secondary,
        ),
      ],
    ),
  );
}

class _PastelOfferCard extends StatefulWidget {
  const _PastelOfferCard({super.key, required this.offer, required this.style});
  final OfferSummary offer;
  final ShiftVisualStyle style;
  @override
  State<_PastelOfferCard> createState() => _PastelOfferCardState();
}

class _PastelOfferCardState extends State<_PastelOfferCard> {
  final _surface = GlobalKey();
  bool _opening = false;
  Future<void> _open() async {
    if (_opening) return;
    final box = _surface.currentContext!.findRenderObject()! as RenderBox;
    final route = shiftDetailRoute(
      context,
      widget.offer,
      box.localToGlobal(Offset.zero) & box.size,
      schedule: true,
      visualStyle: widget.style,
    );
    setState(() => _opening = true);
    await Navigator.of(context).push(route);
    await (route as TransitionRoute<void>).completed;
    if (mounted) setState(() => _opening = false);
  }

  @override
  Widget build(BuildContext context) {
    final offer = widget.offer;
    final offers = context.watch<OffersProvider>();
    final busy = offers.busyOfferId == offer.id;
    final badge = switch (offer.status) {
      'manager_confirmed' =>
        offer.presentation?.state == 'live' ? 'Live now' : 'Confirmed',
      'staff_accepted' => 'Awaiting confirmation',
      _ => 'New Offer',
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Opacity(
        opacity: _opening ? 0 : 1,
        child: ShiftPastelCard(
          surfaceKey: _surface,
          style: widget.style,
          badge: badge,
          role: offer.roleName,
          venue: offer.venueName,
          startsAt: offer.startsAt,
          endsAt: offer.endsAt,
          venuePhotoFileId: offer.venuePhotoFileId,
          onOpen: _open,
          footer: ShiftCardFooterLine(
            text:
                '${payRateLabel(offer.payRatePence)} · ${estimatedPayLabel(offer.payRatePence, offer.estimatedPayPence)}',
          ),
          actions: offer.status != 'pending'
              ? null
              : Column(
                  children: [
                    Row(
                      children: [
                        Expanded(
                          child: SchedulePrimaryButton(
                            label: 'Decline',
                            light: true,
                            onPressed: busy
                                ? null
                                : () => respondToOffer(
                                    context,
                                    offers,
                                    offer.id,
                                    'decline',
                                  ),
                          ),
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: SchedulePrimaryButton(
                            label: 'Accept',
                            busy: busy && offers.busyAction == 'accept',
                            onPressed: busy
                                ? null
                                : () => respondToOffer(
                                    context,
                                    offers,
                                    offer.id,
                                    'accept',
                                  ),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
        ),
      ),
    );
  }
}
