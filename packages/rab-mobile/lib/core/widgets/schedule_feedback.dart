import 'package:flutter/material.dart';
import '../theme/schedule_tokens.dart';
import '../theme/tokens.dart';

/// Shared action geometry. Busy state disables activation and retains its label
/// for assistive technology; content may grow with the user's text size.
/// [light] is the white secondary action (Decline, Teams, Back) beside the
/// black primary one, so both share one height, shape and label style.
class SchedulePrimaryButton extends StatelessWidget {
  const SchedulePrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
    this.light = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool busy;
  final bool light;

  @override
  Widget build(BuildContext context) {
    final foreground = light ? ScheduleTokens.ink : Colors.white;
    // Keep the theme's font family; colour stays the button's own foreground
    // (including its disabled tone).
    final labelStyle = ScheduleType.button.copyWith(
      fontFamily: Theme.of(context).textTheme.labelLarge?.fontFamily,
    );
    return Semantics(
      liveRegion: busy,
      child: SizedBox(
        width: double.infinity,
        child: FilledButton(
          onPressed: busy ? null : onPressed,
          style: FilledButton.styleFrom(
            minimumSize: const Size(0, ScheduleTokens.actionHeight),
            padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
            backgroundColor: light ? Colors.white : ScheduleTokens.accent,
            foregroundColor: foreground,
            disabledBackgroundColor: light
                ? Colors.white.withValues(alpha: .6)
                : const Color(0xFFD9DADF),
            disabledForegroundColor: ScheduleTokens.muted,
            side: light
                ? const BorderSide(color: ScheduleTokens.border)
                : BorderSide.none,
            shape: const StadiumBorder(),
            textStyle: labelStyle,
          ),
          child: Row(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              if (busy)
                SizedBox(
                  width: 18,
                  height: 18,
                  child: CircularProgressIndicator(
                    strokeWidth: 2,
                    color: foreground,
                  ),
                )
              else if (icon != null)
                Icon(icon, size: 20),
              if (busy || icon != null) const SizedBox(width: 8),
              Flexible(
                child: Text(
                  busy ? 'Please wait…' : label,
                  textAlign: TextAlign.center,
                  style: labelStyle,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Sticky bottom action area shared by Job Details, Clock In/Out and Teams:
/// equal side margins, centred content, and clear of the system navigation
/// bar and the keyboard.
class ScheduleBottomAction extends StatelessWidget {
  const ScheduleBottomAction({
    super.key,
    required this.child,
    this.top = 8,
    this.horizontal = ScheduleTokens.actionInset,
  });
  final Widget child;
  final double top, horizontal;

  @override
  Widget build(BuildContext context) => SafeArea(
    top: false,
    minimum: const EdgeInsets.only(bottom: 12),
    child: Padding(
      padding: EdgeInsets.fromLTRB(horizontal, top, horizontal, 0),
      child: Center(
        heightFactor: 1,
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 520),
          child: child,
        ),
      ),
    ),
  );
}

enum ScheduleMessageKind { info, success, warning, error }

/// State is conveyed by text and an icon, never by color alone.
class ScheduleMessageCard extends StatelessWidget {
  const ScheduleMessageCard({
    super.key,
    required this.title,
    this.message,
    this.kind = ScheduleMessageKind.info,
    this.actionLabel,
    this.onAction,
  });
  final String title;
  final String? message, actionLabel;
  final ScheduleMessageKind kind;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (kind) {
      ScheduleMessageKind.info => (ScheduleTokens.lavender, Icons.info_outline),
      ScheduleMessageKind.success => (
        ScheduleTokens.homeMint,
        Icons.check_circle_outline,
      ),
      ScheduleMessageKind.warning => (
        ScheduleTokens.homePeach,
        Icons.warning_amber_rounded,
      ),
      ScheduleMessageKind.error => (
        ScheduleTokens.dangerSoft,
        Icons.error_outline,
      ),
    };
    final foreground = switch (kind) {
      ScheduleMessageKind.error => ScheduleTokens.errorText,
      ScheduleMessageKind.success => ScheduleTokens.successText,
      // Schedule cards retain light surfaces in both app themes.
      ScheduleMessageKind.warning => AppColorsX.light.warning,
      _ => ScheduleTokens.ink,
    };
    return Semantics(
      liveRegion: kind == ScheduleMessageKind.error,
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.all(16),
        decoration: BoxDecoration(
          color: color,
          borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Icon(icon, size: 22, color: foreground),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    style: ScheduleTokens.body.copyWith(
                      // A separate card heading stays neutral. Without a body,
                      // this text is the feedback message itself.
                      color: message == null ? foreground : ScheduleTokens.ink,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(
                message!,
                style: ScheduleTokens.body.copyWith(color: foreground),
              ),
            ],
            if (actionLabel != null && onAction != null) ...[
              const SizedBox(height: 12),
              SchedulePrimaryButton(label: actionLabel!, onPressed: onAction),
            ],
          ],
        ),
      ),
    );
  }
}

/// Owns modal insets and scrolling; callers supply content and operation guards.
/// Dismissal only returns null: it never invokes a confirmation callback.
Future<T?> showScheduleSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isScrollControlled = true,
  bool isDismissible = true,
  bool enableDrag = true,
}) => showModalBottomSheet<T>(
  context: context,
  builder: (sheet) => Padding(
    padding: EdgeInsets.only(bottom: MediaQuery.viewInsetsOf(sheet).bottom),
    child: ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight:
            (MediaQuery.sizeOf(sheet).height * .85 -
                    MediaQuery.viewInsetsOf(sheet).bottom)
                .clamp(0, double.infinity),
      ),
      child: SafeArea(
        top: false,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(
            ScheduleTokens.sheetInset,
            0,
            ScheduleTokens.sheetInset,
            ScheduleTokens.sheetInset,
          ),
          child: builder(sheet),
        ),
      ),
    ),
  ),
  backgroundColor: ScheduleTokens.surface,
  shape: const RoundedRectangleBorder(
    borderRadius: BorderRadius.vertical(
      top: Radius.circular(ScheduleTokens.sheetRadius),
    ),
  ),
  clipBehavior: Clip.antiAlias,
  showDragHandle: true,
  useSafeArea: true,
  isScrollControlled: isScrollControlled,
  isDismissible: isDismissible,
  enableDrag: enableDrag,
);

Future<void> showScheduleMessageSheet({
  required BuildContext context,
  required String title,
  required String message,
  ScheduleMessageKind kind = ScheduleMessageKind.info,
  String actionLabel = 'OK',
}) => showScheduleSheet<void>(
  context: context,
  isScrollControlled: true,
  builder: (sheet) => ScheduleMessageCard(
    title: title,
    message: message,
    kind: kind,
    actionLabel: actionLabel,
    onAction: () => Navigator.pop(sheet),
  ),
);
