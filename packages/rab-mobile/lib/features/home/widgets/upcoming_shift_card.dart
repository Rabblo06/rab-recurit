import '../../../core/widgets/schedule_record_card.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import '../../../core/models/offer.dart';
import '../../../core/motion/shift_motion.dart';
import '../../../core/theme/money.dart';
import '../../../core/theme/tokens.dart';
import '../../../core/theme/schedule_tokens.dart';
import '../../../core/theme/shift_visual_style.dart';
import '../../../core/widgets/rab_venue_motif.dart';

/// Shared visual surface for the deck, expanding list and detail flight.
/// Only fields present in OfferSummary are shown; estimated pay is not an hourly rate.
class UpcomingShiftCard extends StatelessWidget {
  const UpcomingShiftCard({
    super.key,
    required this.offer,
    this.onOpen,
    this.contentOpacity = 1,
    this.materialDepth = 0,
    this.schedule = false,
    this.backgroundOverride,
    this.visualStyle,
    this.homeLayout = false,
  });
  final OfferSummary offer;
  final VoidCallback? onOpen;
  final double contentOpacity;
  final double materialDepth;
  final bool schedule;
  final bool homeLayout;
  static double homeHeightFor(BuildContext context) =>
      168 + (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(0, 32) * 14;

  /// Optional surface override for presentation previews.
  final Color? backgroundOverride;
  final ShiftVisualStyle? visualStyle;
  static double heightFor(BuildContext context, {bool schedule = false}) =>
      (schedule ? 180 : HomeGeometry.cardHeight) +
      (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(0, 32) * 14;
  @override
  Widget build(BuildContext context) {
    if (schedule) return _scheduleCard(context);
    final colors = context.colors;
    final text = context.text;
    return RepaintBoundary(
      child: Container(
        padding: const EdgeInsets.fromLTRB(18, 18, 16, 18),
        decoration: BoxDecoration(
          gradient: HomePalette.stackGradient(materialDepth),
          borderRadius: BorderRadius.circular(HomeGeometry.cardRadius),
          boxShadow: HomeGeometry.cardShadow,
          border: Border.all(
            color: Colors.white.withValues(alpha: .12),
            width: .7,
          ),
        ),
        child: Opacity(
          opacity: contentOpacity,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  SizedBox(
                    width: 42,
                    height: 42,
                    child: ExcludeSemantics(
                      child: RabVenueMotif(
                        baseColor: colors.atmosphereDeep,
                        borderRadius: BorderRadius.all(Radius.circular(21)),
                      ),
                    ),
                  ),
                  const SizedBox(width: 12),
                  Expanded(
                    child: Text(
                      offer.venueName,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: text.section.copyWith(color: colors.onDarkPrimary),
                    ),
                  ),
                  const SizedBox(width: 8),
                  MotionPress(
                    label: 'Open shift at ${offer.venueName}',
                    onPressed: onOpen,
                    child: Container(
                      width: 36,
                      height: 36,
                      decoration: const BoxDecoration(
                        color: Colors.white,
                        shape: BoxShape.circle,
                        boxShadow: HomeGeometry.smallShadow,
                      ),
                      child: Icon(
                        Icons.north_east_rounded,
                        color: colors.atmosphereDeep,
                        size: 20,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 8),
              Text(
                offer.roleName,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: text.pageTitle.copyWith(
                  fontSize: 28,
                  color: colors.onDarkPrimary,
                ),
              ),
              const SizedBox(height: 8),
              Text(
                '${DateFormat('EEE d MMM').format(offer.startsAt.toLocal())} · ${DateFormat('HH:mm').format(offer.startsAt.toLocal())}–${DateFormat('HH:mm').format(offer.endsAt.toLocal())}',
                maxLines: 2,
                style: text.label.copyWith(
                  color: colors.onDarkPrimary,
                  shadows: const [HomePalette.greenTextShadow],
                ),
              ),
              const SizedBox(height: 6),
              Text(
                '${formatPence(offer.estimatedPayPence)} estimated pay',
                style: text.label.copyWith(
                  color: colors.onDarkPrimary,
                  shadows: const [HomePalette.greenTextShadow],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _scheduleCard(BuildContext context) {
    final color =
        backgroundOverride ??
        visualStyle?.card ??
        ShiftVisualStyle.forShift(offer.shiftId).card;
    if (homeLayout) return _homeCard(color);
    return RepaintBoundary(
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 8, 10, 18),
        decoration: ScheduleTokens.panel(color),
        child: Opacity(
          opacity: contentOpacity,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  const SizedBox(width: 38),
                  Expanded(
                    child: Text(
                      offer.roleName,
                      textAlign: TextAlign.center,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ScheduleTokens.body.copyWith(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  MotionPress(
                    label: 'Open shift at ${offer.venueName}',
                    onPressed: onOpen,
                    child: Container(
                      width: 32,
                      height: 32,
                      decoration: const BoxDecoration(
                        color: ScheduleTokens.surface,
                        shape: BoxShape.circle,
                      ),
                      child: const Icon(
                        Icons.north_east,
                        size: 20,
                        color: ScheduleTokens.ink,
                      ),
                    ),
                  ),
                ],
              ),
              Text(
                offer.venueName,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: ScheduleTokens.label,
              ),
              const Spacer(),
              Text(
                '${DateFormat('EEE d MMM').format(offer.startsAt.toLocal())} · '
                '${DateFormat('HH:mm').format(offer.startsAt.toLocal())}–${DateFormat('HH:mm').format(offer.endsAt.toLocal())}',
                style: ScheduleTokens.label.copyWith(color: ScheduleTokens.ink),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _homeCard(Color color) => RepaintBoundary(
    child: ScheduleRecordCard(
      title: offer.roleName,
      openLabel: 'Open shift at ${offer.venueName}',
      venue: offer.venueName,
      scheduleLabel:
          '${DateFormat('EEE dd/MM/yy').format(offer.startsAt.toLocal())} \u00b7 '
          '${DateFormat('HH:mm').format(offer.startsAt.toLocal())}\u2013${DateFormat('HH:mm').format(offer.endsAt.toLocal())}',
      color: color,
      metricLabel: 'Pay rate',
      metricValue: '${formatPence(offer.payRatePence)}/h',
      teamLabel: 'Team Member',
      names: [offer.staffName],
      onOpen: onOpen,
      opacity: contentOpacity,
      lifted: true,
    ),
  );
}
