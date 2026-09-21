import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../home/widgets/shift_routes.dart';
import 'offers_provider.dart';

/// Both collections read the same authoritative provider; presentation never
/// copies a record into another category or changes its lifecycle.
class ScheduleOffersScreen extends StatelessWidget {
  const ScheduleOffersScreen({super.key, this.confirmed = false});
  final bool confirmed;

  @override
  Widget build(BuildContext context) {
    final provider = context.watch<OffersProvider>();
    final items = provider.offers
        .where(
          (offer) => confirmed
              ? offer.status == 'manager_confirmed'
              : offer.status == 'pending' || offer.status == 'staff_accepted',
        )
        .toList();
    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      appBar: AppBar(
        backgroundColor: ScheduleTokens.background,
        title: Text(confirmed ? 'Confirmed' : 'Offers'),
        actions: [
          IconButton(
            tooltip: confirmed ? 'Offers' : 'Confirmed',
            icon: Icon(confirmed ? Icons.work_outline : Icons.event_available),
            onPressed: () => Navigator.of(context).push(
              MaterialPageRoute<void>(
                builder: (_) => ScheduleOffersScreen(confirmed: !confirmed),
              ),
            ),
          ),
        ],
      ),
      body: provider.isLoading
          ? const Center(child: CircularProgressIndicator())
          : RefreshIndicator(
              onRefresh: provider.refresh,
              child: ListView.builder(
                physics: const AlwaysScrollableScrollPhysics(),
                padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
                itemCount: items.length + 1,
                itemBuilder: (context, index) {
                  if (index == 0) {
                    if (provider.loadError != null) {
                      return Column(
                        children: [
                          Text(
                            provider.loadError!,
                            textAlign: TextAlign.center,
                          ),
                          TextButton(
                            onPressed: provider.refresh,
                            child: const Text('Retry'),
                          ),
                        ],
                      );
                    }
                    if (items.isEmpty) {
                      return Padding(
                        padding: const EdgeInsets.symmetric(vertical: 48),
                        child: Text(
                          confirmed
                              ? 'No confirmed shifts yet.'
                              : 'No pending offers. New offers will appear here.',
                          textAlign: TextAlign.center,
                          style: ScheduleTokens.body,
                        ),
                      );
                    }
                    return const SizedBox.shrink();
                  }
                  final offer = items[index - 1];
                  return _PastelOfferCard(
                    key: ValueKey(offer.id),
                    offer: offer,
                    style: ShiftVisualStyle
                        .values[(index - 1) % ShiftVisualStyle.values.length],
                  );
                },
              ),
            ),
    );
  }
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
    final status = switch (offer.status) {
      'manager_confirmed' => 'CONFIRMED',
      'staff_accepted' => 'Waiting for manager confirmation',
      _ => 'PENDING',
    };
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Opacity(
        opacity: _opening ? 0 : 1,
        child: Container(
          key: _surface,
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: widget.style.card,
            borderRadius: BorderRadius.circular(24),
            boxShadow: widget.style.shadows,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Expanded(
                    child: Text(offer.roleName, style: ScheduleTokens.heading),
                  ),
                  IconButton.filledTonal(
                    tooltip: 'Open ${offer.roleName}',
                    onPressed: _open,
                    style: IconButton.styleFrom(
                      backgroundColor: Colors.white,
                      foregroundColor: ScheduleTokens.ink,
                    ),
                    icon: const Icon(Icons.north_east),
                  ),
                ],
              ),
              Text(offer.venueName, style: ScheduleTokens.body),
              if (offer.venueAddress?.trim().isNotEmpty == true)
                Text(offer.venueAddress!, style: ScheduleTokens.label),
              const SizedBox(height: 28),
              Text(
                '${DateFormat('EEE d MMM').format(offer.startsAt.toLocal())} · ${DateFormat('HH:mm').format(offer.startsAt.toLocal())}–${DateFormat('HH:mm').format(offer.endsAt.toLocal())}',
                style: ScheduleTokens.body,
              ),
              const SizedBox(height: 6),
              Text(
                '${formatPence(offer.payRatePence)}/h · ${formatPence(offer.estimatedPayPence)} estimated pay',
                style: ScheduleTokens.body,
              ),
              const SizedBox(height: 14),
              Text(
                status,
                style: ScheduleTokens.body.copyWith(
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
