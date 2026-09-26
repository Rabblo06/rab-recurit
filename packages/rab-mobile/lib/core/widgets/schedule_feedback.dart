import 'package:flutter/material.dart';
import '../theme/schedule_tokens.dart';

/// Shared action geometry. Busy state disables activation and retains its label
/// for assistive technology; content may grow with the user's text size.
class SchedulePrimaryButton extends StatelessWidget {
  const SchedulePrimaryButton({
    super.key,
    required this.label,
    required this.onPressed,
    this.icon,
    this.busy = false,
  });
  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final bool busy;

  @override
  Widget build(BuildContext context) => Semantics(
    liveRegion: busy,
    child: SizedBox(
      width: double.infinity,
      child: FilledButton(
        onPressed: busy ? null : onPressed,
        style: FilledButton.styleFrom(
          minimumSize: const Size(0, ScheduleTokens.touchTarget),
          padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 14),
          backgroundColor: ScheduleTokens.accent,
          foregroundColor: Colors.white,
          shape: const StadiumBorder(),
        ),
        child: Row(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            if (busy)
              const SizedBox(
                width: 18,
                height: 18,
                child: CircularProgressIndicator(
                  strokeWidth: 2,
                  color: Colors.white,
                ),
              )
            else if (icon != null)
              Icon(icon, size: 18),
            if (busy || icon != null) const SizedBox(width: 8),
            Flexible(
              child: Text(
                busy ? 'Please wait…' : label,
                textAlign: TextAlign.center,
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
            ),
          ],
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
                Icon(icon, size: 22, color: ScheduleTokens.ink),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    title,
                    style: ScheduleTokens.body.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                ),
              ],
            ),
            if (message != null) ...[
              const SizedBox(height: 8),
              Text(message!, style: ScheduleTokens.body),
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
