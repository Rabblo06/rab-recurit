import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../theme/schedule_tokens.dart';
import '../theme/shift_visual_style.dart';
import 'venue_photo.dart';

/// Status pill in the shift's own identity colour ("New Offer", "Confirmed").
/// [warning] switches to the shared danger tone for attention states; the text
/// always states the status, so colour is never the only signal.
class ShiftStatusBadge extends StatelessWidget {
  const ShiftStatusBadge({
    super.key,
    required this.label,
    required this.style,
    this.warning = false,
  });
  final String label;
  final ShiftVisualStyle style;
  final bool warning;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
    decoration: BoxDecoration(
      color: warning ? ScheduleTokens.dangerSoft : style.badgeSurface,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      style: ScheduleType.badge.copyWith(
        color: warning ? ScheduleTokens.errorText : style.badgeText,
      ),
    ),
  );
}

/// Icon + text metadata used on shift cards (date, time).
class ShiftMetaItem extends StatelessWidget {
  const ShiftMetaItem({super.key, required this.icon, required this.label});
  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 18, color: ScheduleTokens.muted),
      const SizedBox(width: 6),
      Flexible(
        child: Text(
          label,
          style: ScheduleType.secondary.copyWith(color: ScheduleTokens.ink),
        ),
      ),
    ],
  );
}

/// Pay / outcome line under a card divider, with the reference's leading bar.
class ShiftCardFooterLine extends StatelessWidget {
  const ShiftCardFooterLine({super.key, required this.text, this.color});
  final String text;
  final Color? color;

  @override
  Widget build(BuildContext context) => IntrinsicHeight(
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        Container(width: 2, color: ScheduleTokens.muted.withValues(alpha: .5)),
        const SizedBox(width: 10),
        Expanded(
          child: Text(
            text,
            style: ScheduleType.secondary.copyWith(
              color: color ?? ScheduleTokens.muted,
            ),
          ),
        ),
      ],
    ),
  );
}

/// The shared Offers / Confirmed / History shift card: identity-coloured
/// surface, status badge, role, venue, date and time, a divider, then a
/// caller-supplied footer and optional actions. It owns no provider, rule or
/// navigation; [onOpen] is the caller's.
class ShiftPastelCard extends StatelessWidget {
  const ShiftPastelCard({
    super.key,
    required this.style,
    required this.badge,
    required this.role,
    required this.venue,
    required this.startsAt,
    required this.endsAt,
    this.badgeWarning = false,
    this.footer,
    this.actions,
    this.onOpen,
    this.surfaceKey,
    this.venuePhotoFileId,
  });
  final ShiftVisualStyle style;
  final String badge, role, venue;
  final bool badgeWarning;
  final DateTime startsAt, endsAt;
  final Widget? footer, actions;
  final VoidCallback? onOpen;
  final Key? surfaceKey;
  final String? venuePhotoFileId;

  @override
  Widget build(BuildContext context) {
    final start = startsAt.toLocal(), end = endsAt.toLocal();
    return Container(
      key: surfaceKey,
      padding: const EdgeInsets.fromLTRB(18, 16, 14, 18),
      decoration: BoxDecoration(
        color: style.card,
        borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
        border: Border.all(color: style.cardBorder),
        boxShadow: style.shadows,
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(
                child: Align(
                  alignment: Alignment.centerLeft,
                  child: ShiftStatusBadge(
                    label: badge,
                    style: style,
                    warning: badgeWarning,
                  ),
                ),
              ),
              if (onOpen != null)
                Semantics(
                  button: true,
                  label: 'Open $role',
                  child: ExcludeSemantics(
                    child: IconButton(
                      tooltip: 'Open $role',
                      onPressed: onOpen,
                      constraints: const BoxConstraints.tightFor(
                        width: ScheduleTokens.touchTarget,
                        height: ScheduleTokens.touchTarget,
                      ),
                      padding: EdgeInsets.zero,
                      icon: Container(
                        width: 38,
                        height: 38,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                        ),
                        child: const Icon(
                          Icons.north_east,
                          size: 20,
                          color: ScheduleTokens.ink,
                        ),
                      ),
                    ),
                  ),
                ),
            ],
          ),
          const SizedBox(height: 6),
          Row(
            children: [
              if (venuePhotoFileId != null) ...[
                VenuePhoto(
                  fileId: venuePhotoFileId,
                  size: 44,
                  radius: 12,
                  placeholderColor: style.badgeSurface,
                  semanticLabel: '$venue photo',
                ),
                const SizedBox(width: 12),
              ],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      role,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ScheduleType.cardTitle.copyWith(fontSize: 20),
                    ),
                    const SizedBox(height: 2),
                    Text(
                      venue,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: ScheduleType.bodyStrong.copyWith(
                        color: ScheduleTokens.muted,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
          const SizedBox(height: 14),
          Wrap(
            spacing: 20,
            runSpacing: 6,
            children: [
              ShiftMetaItem(
                icon: Icons.calendar_today_outlined,
                label: DateFormat('EEE d MMM').format(start),
              ),
              ShiftMetaItem(
                icon: Icons.schedule,
                label:
                    '${DateFormat('HH:mm').format(start)}–${DateFormat('HH:mm').format(end)}',
              ),
            ],
          ),
          if (footer != null) ...[
            const SizedBox(height: 12),
            Divider(height: 1, color: style.divider),
            const SizedBox(height: 12),
            footer!,
          ],
          if (actions != null) ...[const SizedBox(height: 14), actions!],
        ],
      ),
    );
  }
}
