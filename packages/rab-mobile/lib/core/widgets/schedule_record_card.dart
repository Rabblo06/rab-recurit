import 'package:flutter/material.dart';
import '../theme/schedule_tokens.dart';

class ScheduleAvatarStack extends StatelessWidget {
  const ScheduleAvatarStack({super.key, required this.names});

  /// Only names supplied by the caller's authorized response belong here.
  final List<String> names;
  @override
  Widget build(BuildContext context) {
    final known = names.where((name) => name.trim().isNotEmpty).toList();
    return Semantics(
      label: known.isEmpty ? 'No team members available' : known.join(', '),
      child: ExcludeSemantics(
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final name in known.take(3))
              Align(
                widthFactor: .8,
                child: Tooltip(
                  message: name,
                  child: CircleAvatar(
                    radius: 13,
                    backgroundColor: Colors.white,
                    child: CircleAvatar(
                      radius: 11,
                      backgroundColor: ScheduleTokens.homeMint,
                      child: Text(
                        name
                            .trim()
                            .split(RegExp(r'\s+'))
                            .take(2)
                            .map((s) => s.characters.first)
                            .join()
                            .toUpperCase(),
                        style: const TextStyle(
                          fontSize: 9,
                          color: ScheduleTokens.ink,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            if (known.length > 3)
              CircleAvatar(
                radius: 13,
                backgroundColor: ScheduleTokens.ink,
                child: Text(
                  '+${known.length - 3}',
                  style: const TextStyle(fontSize: 9, color: Colors.white),
                ),
              ),
            if (known.isEmpty)
              const Icon(
                Icons.person_outline,
                size: 24,
                color: ScheduleTokens.muted,
              ),
          ],
        ),
      ),
    );
  }
}

class ScheduleRoundArrow extends StatelessWidget {
  const ScheduleRoundArrow({
    super.key,
    required this.label,
    required this.onPressed,
  });
  final String label;
  final VoidCallback? onPressed;
  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    button: true,
    label: label,
    enabled: onPressed != null,
    child: ExcludeSemantics(
      child: IconButton(
        tooltip: label,
        onPressed: onPressed,
        constraints: const BoxConstraints(
          minWidth: ScheduleTokens.touchTarget,
          minHeight: ScheduleTokens.touchTarget,
        ),
        icon: const CircleAvatar(
          radius: 14,
          backgroundColor: Colors.white,
          child: Icon(Icons.north_east, size: 18, color: ScheduleTokens.ink),
        ),
      ),
    ),
  );
}

/// Shared shift/event content. It owns no provider, role rule or navigation.
class ScheduleRecordCard extends StatelessWidget {
  const ScheduleRecordCard({
    super.key,
    required this.title,
    required this.venue,
    required this.color,
    required this.metricLabel,
    required this.metricValue,
    required this.teamLabel,
    required this.names,
    this.address,
    this.scheduleLabel,
    this.onOpen,
    this.opacity = 1,
    this.lifted = false,
    this.openLabel,
  });
  final String title, venue, metricLabel, metricValue, teamLabel;
  final String? address;
  final String? scheduleLabel;
  final List<String> names;
  final Color color;
  final VoidCallback? onOpen;
  final double opacity;
  final bool lifted;
  final String? openLabel;
  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
      boxShadow: lifted ? ScheduleTokens.homeShadows : null,
    ),
    child: Material(
      color: color,
      clipBehavior: Clip.antiAlias,
      borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
      child: InkWell(
        onTap: onOpen,
        borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(16, 4, 12, 12),
          child: Opacity(
            opacity: opacity,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        title,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ScheduleTokens.heading.copyWith(fontSize: 19),
                      ),
                    ),
                    ScheduleRoundArrow(
                      label: openLabel ?? 'Open $title at $venue',
                      onPressed: onOpen,
                    ),
                  ],
                ),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            venue,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: ScheduleTokens.body.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (address?.trim().isNotEmpty == true)
                            Text(
                              address!,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: ScheduleTokens.label.copyWith(
                                fontSize: 11,
                              ),
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 10),
                    Flexible(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            metricLabel,
                            style: ScheduleTokens.label.copyWith(fontSize: 10),
                          ),
                          Text(
                            metricValue,
                            style: ScheduleTokens.body.copyWith(fontSize: 12),
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                if (scheduleLabel != null)
                  Padding(
                    padding: const EdgeInsets.only(top: 8),
                    child: Text(scheduleLabel!, style: ScheduleTokens.label),
                  ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    Expanded(
                      child: Text(teamLabel, style: ScheduleTokens.label),
                    ),
                    ScheduleAvatarStack(names: names),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    ),
  );
}
