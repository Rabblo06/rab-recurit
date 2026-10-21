import 'package:flutter/material.dart';
import '../theme/schedule_tokens.dart';

/// Back control + title for the staff schedule screens. The title is centred
/// on the screen, not between the controls, so it never shifts with the back
/// button's width. Long titles ellipsize before reaching either control.
/// [centerTitle] false puts the title beside the back control instead
/// (Venue Manager list screens: "← Users  [Edit]").
class ScheduleNavHeader extends StatelessWidget {
  const ScheduleNavHeader({
    super.key,
    required this.title,
    this.onBack,
    this.showBack = true,
    this.trailing,
    this.backgroundColor = Colors.white,
    this.foreground = ScheduleTokens.ink,
    this.titleStyle,
    this.centerTitle = true,
  });
  final String title;
  final VoidCallback? onBack;
  final bool showBack;
  final Widget? trailing;
  final Color backgroundColor;
  final Color foreground;
  final TextStyle? titleStyle;
  final bool centerTitle;

  static const height = 56.0;
  static const _control = 48.0;

  Widget _title() => Semantics(
    header: true,
    child: Text(
      title,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      textAlign: centerTitle ? TextAlign.center : TextAlign.start,
      style: (titleStyle ?? ScheduleType.navTitle).copyWith(color: foreground),
    ),
  );

  Widget _back(BuildContext context) => SizedBox.square(
    dimension: _control,
    child: IconButton(
      tooltip: 'Back',
      onPressed: onBack ?? () => Navigator.maybePop(context),
      icon: Container(
        width: 40,
        height: 40,
        decoration: BoxDecoration(
          color: backgroundColor,
          shape: BoxShape.circle,
          border: backgroundColor == Colors.white
              ? Border.all(color: ScheduleTokens.border)
              : null,
        ),
        child: Icon(Icons.chevron_left, size: 24, color: foreground),
      ),
      padding: EdgeInsets.zero,
    ),
  );

  @override
  Widget build(BuildContext context) {
    if (!centerTitle) {
      return ConstrainedBox(
        constraints: const BoxConstraints(minHeight: height),
        child: Row(
          children: [
            if (showBack) ...[_back(context), const SizedBox(width: 4)],
            Expanded(child: _title()),
            if (trailing != null) ...[const SizedBox(width: 8), trailing!],
          ],
        ),
      );
    }
    return SizedBox(
      height: height,
      child: Stack(
        alignment: Alignment.center,
        children: [
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: _control + 8),
            child: _title(),
          ),
          if (showBack)
            Align(alignment: Alignment.centerLeft, child: _back(context)),
          if (trailing != null)
            Align(alignment: Alignment.centerRight, child: trailing),
        ],
      ),
    );
  }
}
