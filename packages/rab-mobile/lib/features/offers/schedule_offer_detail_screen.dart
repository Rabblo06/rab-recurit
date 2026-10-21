import '../../core/widgets/schedule_feedback.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/venue_photo.dart';
import '../home/attendance_provider.dart';
import '../home/schedule_clock_screen.dart';
import '../home/todays_shift.dart';
import 'offer_response_feedback.dart';
import 'offers_provider.dart';
import 'offer_detail_ui_state.dart';
import 'shift_status_control.dart';

class ScheduleOfferDetailScreen extends StatelessWidget {
  const ScheduleOfferDetailScreen({
    super.key,
    required this.offer,
    ShiftVisualStyle? visualStyle,
  }) : _visualStyle = visualStyle;
  final OfferSummary offer;
  final ShiftVisualStyle? _visualStyle;
  ShiftVisualStyle get visualStyle =>
      _visualStyle ?? ShiftVisualStyle.forShift(offer.shiftId);

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
      // Server-anchored time, as on the clock screen, never the device clock.
      now: attendance.trustedNow,
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
    final hasAction = const {
      OfferDetailUiState.loading,
      OfferDetailUiState.error,
      OfferDetailUiState.offer,
      OfferDetailUiState.clockIn,
      OfferDetailUiState.clockOut,
    }.contains(state);
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
              const Padding(
                padding: EdgeInsets.fromLTRB(8, 4, 8, 0),
                child: ScheduleNavHeader(title: 'Job Details'),
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
                          padding: const EdgeInsets.all(3),
                          decoration: BoxDecoration(
                            color: visualStyle.iconTile,
                            border: Border.all(
                              color: visualStyle.surfaceBorder,
                            ),
                            borderRadius: BorderRadius.circular(28),
                            boxShadow: visualStyle.iconShadows,
                          ),
                          child: VenuePhoto(
                            fileId: current.venuePhotoFileId,
                            size: 88,
                            radius: 25,
                            iconSize: 36,
                            placeholderColor: visualStyle.iconTile,
                            semanticLabel: '${current.venueName} photo',
                          ),
                        ),
                      ),
                      const SizedBox(height: 16),
                      Text(
                        current.roleName,
                        textAlign: TextAlign.center,
                        style: ScheduleType.pageTitle,
                      ),
                      const SizedBox(height: 4),
                      Text(
                        current.venueName,
                        textAlign: TextAlign.center,
                        style: ScheduleType.body,
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
                                style: ScheduleType.secondary.copyWith(
                                  color: ScheduleTokens.ink,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                      const SizedBox(height: 10),
                      Center(
                        child: ShiftStatusControl(
                          offer: current,
                          style: visualStyle,
                          fallback: state.label,
                          reconciling:
                              current.presentation?.state == 'live' &&
                              attendance.history.any(
                                (row) =>
                                    row.shiftId == current.shiftId &&
                                    row.clockOutAt != null,
                              ),
                        ),
                      ),
                      // Finished but not yet in History: History lists
                      // payroll-approved shifts only.
                      if (attendance.history.any(
                        (row) =>
                            row.shiftId == current.shiftId &&
                            row.clockOutAt != null &&
                            !row.payrollApproved,
                      ))
                        Padding(
                          key: const ValueKey('awaiting-payroll'),
                          padding: const EdgeInsets.only(top: 10),
                          child: Text(
                            'Shift completed — Awaiting payroll approval',
                            textAlign: TextAlign.center,
                            style: ScheduleType.secondary.copyWith(
                              color: ScheduleTokens.ink,
                            ),
                          ),
                        ),
                      const SizedBox(height: 16),
                      Wrap(
                        alignment: WrapAlignment.center,
                        spacing: 8,
                        runSpacing: 8,
                        children: [
                          _pill(
                            Icons.currency_pound,
                            payRateLabel(current.payRatePence),
                          ),
                          _pill(
                            Icons.event_outlined,
                            DateFormat(
                              'dd/MM/yy',
                            ).format(current.startsAt.toLocal()),
                          ),
                          _pill(
                            Icons.schedule,
                            '${DateFormat('HH:mm').format(current.startsAt.toLocal())}–${DateFormat('HH:mm').format(current.endsAt.toLocal())}',
                          ),
                        ],
                      ),
                      const SizedBox(height: 14),
                      Divider(color: visualStyle.divider),
                      ...[
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
                            child: const Text(
                              'NOTE',
                              textAlign: TextAlign.center,
                              style: ScheduleType.overline,
                            ),
                          ),
                        ),
                        Container(
                          width: double.infinity,
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
                          child: notes == null || notes.isEmpty
                              ? const Row(
                                  children: [
                                    Icon(
                                      Icons.notes_outlined,
                                      size: 20,
                                      color: ScheduleTokens.muted,
                                    ),
                                    SizedBox(width: 10),
                                    Expanded(
                                      child: Text(
                                        'No shift notes provided.',
                                        style: ScheduleType.secondary,
                                      ),
                                    ),
                                  ],
                                )
                              : Text(notes, style: ScheduleType.body),
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              // Accept/Decline failures are announced as a toast
              // (respondToOffer), not pinned above the action.
              if (hasAction)
                ScheduleBottomAction(
                  child: _action(
                    context,
                    current,
                    state,
                    offers,
                    attendance,
                    retry,
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
        Icon(icon, size: 18, color: ScheduleTokens.ink),
        const SizedBox(width: 6),
        Text(label, style: ScheduleType.bodyStrong.copyWith(fontSize: 14)),
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
                busy
                    ? null
                    : () => respondToOffer(
                        context,
                        offers,
                        current.id,
                        'decline',
                      ),
                light: true,
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              child: _button(
                busy ? 'Please wait…' : 'Accept',
                busy
                    ? null
                    : () =>
                          respondToOffer(context, offers, current.id, 'accept'),
              ),
            ),
          ],
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
        return const SizedBox.shrink();
    }
  }

  Widget _button(String text, VoidCallback? action, {bool light = false}) =>
      SchedulePrimaryButton(label: text, onPressed: action, light: light);
}
