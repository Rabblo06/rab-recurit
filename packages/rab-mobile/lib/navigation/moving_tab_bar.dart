import 'package:flutter/material.dart';
import '../core/theme/tokens.dart';
import '../core/theme/schedule_tokens.dart';

/// Equal fixed cells; selection changes paint only.
class MovingTabBar extends StatefulWidget {
  const MovingTabBar({
    super.key,
    required this.index,
    required this.onSelected,
    this.scheduleStyle = true,
    this.tabLabels,
  });
  final bool scheduleStyle;
  final List<String>? tabLabels;
  final int index;
  final ValueChanged<int> onSelected;
  @override
  State<MovingTabBar> createState() => _MovingTabBarState();
}

class _MovingTabBarState extends State<MovingTabBar> {
  static const labels = ['Home', 'Calendar', 'History', 'Profile'];
  static const icons = [
    Icons.home_outlined,
    Icons.calendar_today_outlined,
    Icons.description_outlined,
    Icons.person_outline,
  ];
  static const scheduleIcons = [
    Icons.work_outline_rounded,
    Icons.calendar_today_outlined,
    Icons.chat_bubble_outline_rounded,
    Icons.person_outline,
  ];
  @override
  Widget build(BuildContext context) {
    final schedule = widget.scheduleStyle;
    final bar = Container(
      key: const ValueKey('navigation-shell'),
      height: schedule ? ScheduleTokens.navigationHeight : null,
      padding: EdgeInsets.symmetric(
        horizontal: schedule ? ScheduleTokens.navigationPadding : 6,
        vertical: schedule ? ScheduleTokens.navigationPadding : 4,
      ),
      decoration: BoxDecoration(
        color: Colors.white,
        borderRadius: BorderRadius.circular(
          schedule ? ScheduleTokens.navigationHeight / 2 : 40,
        ),
        border: Border.all(
          color: schedule
              ? const Color(0xFFE6E5E2)
              : context.colors.border.withValues(alpha: .6),
        ),
        boxShadow: schedule
            ? ScheduleTokens.homeShadows
            : HomeGeometry.navShadow,
      ),
      child: Row(
        children: [
          for (var i = 0; i < 4; i++)
            Expanded(
              child: Semantics(
                key: ValueKey('navigation-item-$i'),
                selected: widget.index == i,
                button: true,
                label: (widget.tabLabels ?? labels)[i],
                child: Tooltip(
                  message: (widget.tabLabels ?? labels)[i],
                  child: InkWell(
                    onTap: () => widget.onSelected(i),
                    borderRadius: BorderRadius.circular(28),
                    child: SizedBox(
                      height: ScheduleTokens.navigationActiveSize,
                      child: Center(
                        child: DecoratedBox(
                          key: widget.index == i
                              ? const ValueKey('moving-tab-pill')
                              : ValueKey('navigation-inactive-$i'),
                          decoration: BoxDecoration(
                            color: widget.index == i
                                ? (schedule
                                      ? ScheduleTokens.accent
                                      : HomePalette.selected)
                                : Colors.transparent,
                            shape: BoxShape.circle,
                          ),
                          child: SizedBox.square(
                            dimension: ScheduleTokens.navigationActiveSize,
                            child: ExcludeSemantics(
                              child: Icon(
                                schedule ? scheduleIcons[i] : icons[i],
                                size: ScheduleTokens.navigationIconSize,
                                color: widget.index == i
                                    ? Colors.white
                                    : (schedule
                                          ? ScheduleTokens.muted
                                          : context.colors.textSecondary),
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
        ],
      ),
    );
    return SafeArea(
      top: false,
      minimum: EdgeInsets.fromLTRB(
        schedule ? 0 : ScheduleTokens.navigationInset,
        0,
        schedule ? 0 : ScheduleTokens.navigationInset,
        schedule ? ScheduleTokens.navigationBottom : 8,
      ),
      child: schedule
          ? Center(
              heightFactor: 1,
              child: ConstrainedBox(
                constraints: const BoxConstraints(
                  maxWidth: ScheduleTokens.navigationMaxWidth,
                ),
                child: SizedBox(
                  width:
                      MediaQuery.sizeOf(context).width *
                      ScheduleTokens.navigationWidthFactor,
                  child: bar,
                ),
              ),
            )
          : bar,
    );
  }
}
