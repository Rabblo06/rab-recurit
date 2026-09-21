import 'package:flutter/material.dart';
import '../motion/shift_motion.dart';
import '../theme/schedule_tokens.dart';

class SchedulePanel extends StatelessWidget {
  const SchedulePanel({super.key, required this.color, required this.child, this.onTap});
  final Color color;
  final Widget child;
  final VoidCallback? onTap;
  @override
  Widget build(BuildContext context) => Material(
    color: color,
    borderRadius: BorderRadius.circular(24),
    child: InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(24),
      child: Padding(padding: const EdgeInsets.all(14), child: child),
    ),
  );
}

class ScheduleSpaceSelector extends StatelessWidget {
  const ScheduleSpaceSelector({super.key, required this.mySpace, required this.onChanged});
  final bool mySpace;
  final ValueChanged<bool> onChanged;
  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final duration = ShiftMotion.reduced(context)
          ? Duration.zero
          : ScheduleTokens.segmentMotion;
      return Container(
        padding: const EdgeInsets.all(3),
        height:
            50 +
            (MediaQuery.textScalerOf(context).scale(12) - 12).clamp(0, 24) * 2,
        decoration: BoxDecoration(
          color: ScheduleTokens.surface,
          borderRadius: BorderRadius.circular(40),
          border: Border.all(color: ScheduleTokens.border),
        ),
        child: Stack(
          children: [
            AnimatedAlign(
              alignment: mySpace ? Alignment.centerRight : Alignment.centerLeft,
              duration: duration,
              curve: Curves.easeOutCubic,
              child: Container(
                width: (constraints.maxWidth - 8) / 2,
                decoration: BoxDecoration(
                  color: ScheduleTokens.accent,
                  borderRadius: BorderRadius.circular(40),
                ),
              ),
            ),
            Row(
              children: [
                for (final space in [false, true])
                  Expanded(
                    child: Semantics(
                      selected: mySpace == space,
                      child: TextButton(
                        onPressed: () => onChanged(space),
                        style: TextButton.styleFrom(
                          padding: const EdgeInsets.symmetric(horizontal: 6),
                        ),
                        child: TweenAnimationBuilder<Color?>(
                          duration: duration,
                          tween: ColorTween(
                            end: mySpace == space
                                ? ScheduleTokens.surface
                                : ScheduleTokens.ink,
                          ),
                          builder: (context, color, _) => Row(
                            mainAxisAlignment: MainAxisAlignment.center,
                            children: [
                              Icon(
                                space
                                    ? Icons.fingerprint
                                    : Icons.people_outline,
                                size: 18,
                                color: color,
                              ),
                              const SizedBox(width: 8),
                              Flexible(
                                child: Text(
                                  space ? 'My Space' : 'organization',
                                  style: TextStyle(fontSize: 12, color: color),
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      );
    },
  );
}

class ScheduleHeader extends StatelessWidget {
  const ScheduleHeader({
    super.key,
    required this.first,
    required this.greeting,
    required this.initials,
    required this.unread,
    required this.onNotifications,
    required this.onProfile,
  });
  final String first, greeting, initials;
  final int unread;
  final VoidCallback onNotifications, onProfile;
  @override
  Widget build(BuildContext context) => ConstrainedBox(
    constraints: const BoxConstraints(minHeight: 72),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                'Good $greeting,',
                style: const TextStyle(
                  fontSize: 24,
                  height: 1.3,
                  color: ScheduleTokens.muted,
                ),
              ),
              const SizedBox(height: 2),
              Text(
                first.isEmpty ? 'Welcome' : first,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 36,
                  height: 1.2,
                  fontWeight: FontWeight.w700,
                  color: ScheduleTokens.ink,
                ),
              ),
            ],
          ),
        ),
        DecoratedBox(
          decoration: const BoxDecoration(
            color: ScheduleTokens.surface,
            shape: BoxShape.circle,
            boxShadow: ScheduleTokens.shadows,
          ),
          child: IconButton(
            tooltip: 'Notifications',
            color: ScheduleTokens.ink,
            onPressed: onNotifications,
            icon: Badge(
              isLabelVisible: unread > 0,
              label: Text('$unread'),
              child: const Icon(Icons.notifications_outlined, size: 22),
            ),
          ),
        ),
        const SizedBox(width: 12),
        IconButton(
          tooltip: 'Profile',
          onPressed: onProfile,
          padding: EdgeInsets.zero,
          icon: CircleAvatar(
            radius: 21,
            backgroundColor: ScheduleTokens.mint,
            child: Text(
              initials.isEmpty ? '—' : initials,
              style: ScheduleTokens.body.copyWith(fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ],
    ),
  );
}
