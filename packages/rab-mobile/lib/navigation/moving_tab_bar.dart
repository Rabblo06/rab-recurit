import 'dart:ui' show lerpDouble;
import 'package:flutter/material.dart';
import '../core/motion/shift_motion.dart';
import '../core/theme/tokens.dart';
import '../core/theme/schedule_tokens.dart';

/// One indicator; every interruption starts at the currently painted weights.
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

class _MovingTabBarState extends State<MovingTabBar>
    with SingleTickerProviderStateMixin {
  late final AnimationController _motion = AnimationController(
    vsync: this,
    duration: ShiftMotion.navigation,
    value: 1,
  );
  late List<double> _from = List.generate(4, (i) => i == widget.index ? 1 : 0);
  late List<double> _to = List.of(_from);
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
  List<double> get _weights => List.generate(
    4,
    (i) => lerpDouble(
      _from[i],
      _to[i],
      Curves.easeOutCubic.transform(_motion.value),
    )!,
  );
  @override
  void didUpdateWidget(MovingTabBar old) {
    super.didUpdateWidget(old);
    if (old.index == widget.index) return;
    _from = _weights;
    _to = List.generate(4, (i) => i == widget.index ? 1 : 0);
    if (ShiftMotion.reduced(context)) {
      _motion.value = 1;
    } else {
      _motion.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _motion.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final schedule = widget.scheduleStyle;
    return SafeArea(
      top: false,
      minimum: EdgeInsets.fromLTRB(24, 0, 24, schedule ? 12 : 8),
      child: Container(
        padding: EdgeInsets.symmetric(
          horizontal: 6,
          vertical: schedule ? 2 : 4,
        ),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(40),
          border: Border.all(
            color: context.colors.border.withValues(alpha: .6),
          ),
          boxShadow: schedule
              ? ScheduleTokens.homeShadows
              : HomeGeometry.navShadow,
        ),
        child: LayoutBuilder(
          builder: (context, box) => AnimatedBuilder(
            animation: _motion,
            builder: (context, _) {
              final weights = _weights;
              final extra = schedule
                  ? 0.0
                  : (box.maxWidth * .16).clamp(44.0, 72.0);
              final base = (box.maxWidth - extra) / 4;
              final widths = weights
                  .map((w) => schedule ? 48.0 : base + extra * w)
                  .toList();
              final starts = <double>[0];
              for (var i = 1; i < 4; i++) {
                starts.add(
                  schedule
                      ? i * (box.maxWidth - 48) / 3
                      : starts.last + widths[i - 1],
                );
              }
              var pillX = 0.0, pillWidth = 0.0;
              for (var i = 0; i < 4; i++) {
                pillX += starts[i] * weights[i];
                pillWidth += widths[i] * weights[i];
              }
              return SizedBox(
                height: 48,
                child: Stack(
                  children: [
                    Positioned(
                      left: pillX + (schedule ? 4 : 0),
                      top: schedule ? 4 : 7,
                      width: schedule ? 40 : pillWidth,
                      height: schedule ? 40 : 34,
                      child: DecoratedBox(
                        key: const ValueKey('moving-tab-pill'),
                        decoration: BoxDecoration(
                          color: schedule
                              ? ScheduleTokens.accent
                              : HomePalette.selected,
                          borderRadius: BorderRadius.circular(28),
                        ),
                      ),
                    ),
                    for (var i = 0; i < 4; i++)
                      Positioned(
                        left: starts[i],
                        width: widths[i],
                        top: 0,
                        bottom: 0,
                        child: Semantics(
                          selected: widget.index == i,
                          button: true,
                          label: (widget.tabLabels ?? labels)[i],
                          child: Tooltip(
                            message: (widget.tabLabels ?? labels)[i],
                            child: InkWell(
                              onTap: () => widget.onSelected(i),
                              borderRadius: BorderRadius.circular(28),
                              child: ExcludeSemantics(
                                child: Row(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  children: [
                                    Icon(
                                      schedule ? scheduleIcons[i] : icons[i],
                                      size: schedule ? 20 : 22,
                                      color: Color.lerp(
                                        context.colors.textSecondary,
                                        Colors.white,
                                        weights[i],
                                      ),
                                    ),
                                    if (!schedule)
                                      ClipRect(
                                        child: Align(
                                          widthFactor: weights[i],
                                          alignment: Alignment.centerLeft,
                                          child: Opacity(
                                            opacity: weights[i],
                                            child: Padding(
                                              padding: const EdgeInsets.only(
                                                left: 7,
                                              ),
                                              child: Text(
                                                (widget.tabLabels ?? labels)[i],
                                                maxLines: 1,
                                                style: context.text.label
                                                    .copyWith(
                                                      color: Colors.white,
                                                      fontSize: 12,
                                                      fontWeight:
                                                          FontWeight.w600,
                                                    ),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                          ),
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        ),
      ),
    );
  }
}
