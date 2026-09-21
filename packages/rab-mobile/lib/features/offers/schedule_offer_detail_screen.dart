import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/rab_round_back_button.dart';
import '../home/attendance_provider.dart';
import '../home/schedule_clock_screen.dart';
import '../home/todays_shift.dart';
import 'offers_provider.dart';
import 'offer_detail_ui_state.dart';

class ScheduleOfferDetailScreen extends StatelessWidget {
  const ScheduleOfferDetailScreen({
    super.key,
    required this.offer,
    this.visualStyle = ShiftVisualStyle.lavender,
  });
  final OfferSummary offer;
  final ShiftVisualStyle visualStyle;

  @override
  Widget build(BuildContext context) {
    final offers = context.watch<OffersProvider>();
    final attendance = context.watch<AttendanceProvider>();
    final current =
        offers.offers.where((o) => o.id == offer.id).firstOrNull ?? offer;
    final state = OfferDetailUiState.resolve(
      offer: current,
      active: attendance.active,
      history: attendance.history,
      clockableShiftId: todaysConfirmedOffer(offers.offers)?.shiftId,
      loading:
          offers.isLoading ||
          attendance.isLoadingActive ||
          attendance.isLoadingHistory,
      failed:
          offers.loadError != null ||
          attendance.activeLoadError != null ||
          attendance.historyLoadError != null,
    );
    final notes = current.shiftNotes?.trim();
    Future<void> retry() async {
      await Future.wait([
        offers.refresh(),
        attendance.refreshActive(),
        attendance.loadHistory(),
      ]);
    }

    return Scaffold(
      backgroundColor: visualStyle.page,
      body: DecoratedBox(
        decoration: BoxDecoration(gradient: visualStyle.detailGradient),
        child: SafeArea(
          child: Column(
            children: [
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
                child: Row(
                  children: [
                    RabRoundBackButton(
                      onPressed: () => Navigator.of(context).maybePop(),
                      color: ScheduleTokens.ink,
                      backgroundColor: Colors.white,
                    ),
                    const Spacer(),
                    Text(
                      'Job Details',
                      style: ScheduleTokens.heading.copyWith(fontSize: 16),
                    ),
                    const Spacer(),
                    const SizedBox(width: 40),
                  ],
                ),
              ),
              Expanded(
                child: RefreshIndicator(
                  onRefresh: retry,
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(20, 12, 20, 24),
                    children: [
                      Center(
                        child: Container(
                          width: 88,
                          height: 88,
                          decoration: BoxDecoration(
                            color: visualStyle.iconTile,
                            border: Border.all(
                              color: visualStyle.surfaceBorder,
                            ),
                            borderRadius: BorderRadius.circular(26),
                            boxShadow: visualStyle.iconShadows,
                          ),
                          child: const Icon(
                            Icons.storefront_outlined,
                            size: 34,
                            color: ScheduleTokens.ink,
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        current.roleName,
                        textAlign: TextAlign.center,
                        style: ScheduleTokens.heading.copyWith(fontSize: 24),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        current.venueName,
                        textAlign: TextAlign.center,
                        style: ScheduleTokens.body,
                      ),
                      if (current.venueAddress?.trim().isNotEmpty == true) ...[
                        const SizedBox(height: 4),
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            const Icon(
                              Icons.place_outlined,
                              size: 15,
                              color: ScheduleTokens.ink,
                            ),
                            const SizedBox(width: 4),
                            Flexible(
                              child: Text(
                                current.venueAddress!,
                                textAlign: TextAlign.center,
                                style: ScheduleTokens.body.copyWith(
                                  fontSize: 12,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 10),
                      Center(
                        child: _pill(
                          Icons.work_outline,
                          state.label,
                          status: true,
                        ),
                      ),
                      const SizedBox(height: 16),
                      SingleChildScrollView(
                        scrollDirection: Axis.horizontal,
                        child: Row(
                          children: [
                            _pill(
                              Icons.currency_pound,
                              '${formatPence(current.payRatePence)}/h',
                            ),
                            const SizedBox(width: 6),
                            _pill(
                              Icons.event_outlined,
                              DateFormat(
                                'dd/MM/yy',
                              ).format(current.startsAt.toLocal()),
                            ),
                            const SizedBox(width: 6),
                            _pill(
                              Icons.schedule,
                              '${DateFormat('HH:mm').format(current.startsAt.toLocal())}–${DateFormat('HH:mm').format(current.endsAt.toLocal())}',
                            ),
                          ],
                        ),
                      ),
                      const SizedBox(height: 14),
                      Divider(color: visualStyle.divider),
                      if (notes != null && notes.isNotEmpty) ...[
                        const SizedBox(height: 18),
                        Center(
                          child: Container(
                            width: 168,
                            padding: const EdgeInsets.fromLTRB(16, 10, 16, 16),
                            decoration: BoxDecoration(
                              color: visualStyle.noteChip,
                              borderRadius: const BorderRadius.vertical(
                                top: Radius.circular(16),
                              ),
                            ),
                            child: Text(
                              'NOTE',
                              textAlign: TextAlign.center,
                              style: ScheduleTokens.body.copyWith(
                                fontSize: 12,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                          ),
                        ),
                        Container(
                          constraints: const BoxConstraints(minHeight: 220),
                          padding: const EdgeInsets.all(22),
                          decoration: BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.circular(28),
                            border: Border.all(
                              color: visualStyle.surfaceBorder.withValues(
                                alpha: .12,
                              ),
                            ),
                            boxShadow: visualStyle.noteShadows,
                          ),
                          child: Text(
                            notes,
                            style: ScheduleTokens.body.copyWith(fontSize: 14),
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              Padding(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (offers.errorOfferId == current.id &&
                        offers.errorMessage != null)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 8),
                        child: Text(
                          offers.errorMessage!,
                          style: ScheduleTokens.body,
                        ),
                      ),
                    _action(context, current, state, offers, attendance, retry),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _pill(IconData icon, String label, {bool status = false}) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
    decoration: BoxDecoration(
      color: status ? visualStyle.chipSurface : visualStyle.metadataSurface,
      border: Border.all(color: visualStyle.surfaceBorder),
      boxShadow: visualStyle.metadataShadows,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 16, color: ScheduleTokens.ink),
        const SizedBox(width: 6),
        Text(
          label,
          style: ScheduleTokens.body.copyWith(
            fontSize: 12,
            fontWeight: FontWeight.w600,
          ),
        ),
      ],
    ),
  );

  Widget _action(
    BuildContext context,
    OfferSummary current,
    OfferDetailUiState state,
    OffersProvider offers,
    AttendanceProvider attendance,
    Future<void> Function() retry,
  ) {
    final busy = offers.busyOfferId == current.id;
    switch (state) {
      case OfferDetailUiState.loading:
        return const SizedBox(
          height: 52,
          child: Center(child: CircularProgressIndicator()),
        );
      case OfferDetailUiState.error:
        return Column(
          children: [
            Text(
              offers.loadError ??
                  attendance.activeLoadError ??
                  attendance.historyLoadError ??
                  'Unable to check this shift.',
              textAlign: TextAlign.center,
            ),
            TextButton(onPressed: retry, child: const Text('Retry')),
          ],
        );
      case OfferDetailUiState.offer:
        return Row(
          children: [
            Expanded(
              child: _button(
                'Decline',
                busy ? null : () => offers.respond(current.id, 'decline'),
                light: true,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _button(
                busy ? 'Please wait…' : 'Accept',
                busy ? null : () => offers.respond(current.id, 'accept'),
              ),
            ),
          ],
        );
      case OfferDetailUiState.pending:
        return const Padding(
          padding: EdgeInsets.symmetric(vertical: 16),
          child: Text(
            'Waiting for confirmation',
            textAlign: TextAlign.center,
            style: ScheduleTokens.body,
          ),
        );
      case OfferDetailUiState.ready:
        return _button(
          'Be Ready',
          () => showModalBottomSheet<void>(
            context: context,
            showDragHandle: true,
            builder: (_) => SafeArea(
              child: Padding(
                padding: const EdgeInsets.fromLTRB(24, 0, 24, 28),
                child: Text(
                  attendance.active != null
                      ? 'Finish your active shift before starting another.'
                      : 'Your shift is confirmed. Check the date, location and instructions above. Clock In becomes available here when this is your current shift.',
                  style: ScheduleTokens.body,
                ),
              ),
            ),
          ),
        );
      case OfferDetailUiState.clockIn:
      case OfferDetailUiState.clockOut:
        return _button(
          state == OfferDetailUiState.clockOut ? 'Clock Out' : 'Clock In',
          () => Navigator.of(context).push(
            ScheduleClockScreen.route(offer: current, visualStyle: visualStyle),
          ),
        );
      default:
        return Padding(
          padding: const EdgeInsets.symmetric(vertical: 16),
          child: Text(state.label, style: ScheduleTokens.body),
        );
    }
  }

  Widget _button(String text, VoidCallback? action, {bool light = false}) =>
      SizedBox(
        width: double.infinity,
        height: 52,
        child: FilledButton(
          onPressed: action,
          style: FilledButton.styleFrom(
            backgroundColor: light ? Colors.white : ScheduleTokens.accent,
            foregroundColor: light ? ScheduleTokens.ink : Colors.white,
            shape: const StadiumBorder(),
          ),
          child: Text(
            text,
            style: const TextStyle(fontWeight: FontWeight.w700),
          ),
        ),
      );
}
