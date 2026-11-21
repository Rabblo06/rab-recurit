import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import 'offline_entry.dart';
import 'offline_messages.dart';
import 'offline_sync_controller.dart';

/// "Saved actions": every punch saved on this phone with its state (DESIGN §3.6). Waiting entries cannot be removed
/// one by one (only the logout guard's explicit "discard"); refused, too-old and could-not-send entries can be
/// dismissed once seen.
class SavedActionsScreen extends StatelessWidget {
  const SavedActionsScreen({super.key});

  static Route<void> route() =>
      MaterialPageRoute<void>(builder: (_) => const SavedActionsScreen());

  @override
  Widget build(BuildContext context) {
    final offline = context.watch<OfflineSyncController?>();
    final entries = offline?.entries ?? const <QueuedPunch>[];
    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: ScheduleNavHeader(title: 'Saved actions'),
            ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 8, 20, 24),
                children: [
                  if (offline?.unreadable == true)
                    ScheduleMessageCard(
                      key: const ValueKey('offline-unreadable'),
                      title: 'Saved actions could not be read',
                      message: OfflineMessages.unreadable,
                      kind: ScheduleMessageKind.error,
                      actionLabel: 'Dismiss',
                      onAction: offline!.discardAll,
                    ),
                  if ((offline?.pendingCount ?? 0) > 0)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: SchedulePrimaryButton(
                        key: const ValueKey('offline-send-now'),
                        label: 'Send now',
                        busy: offline!.isSyncing,
                        onPressed: offline.isSyncing
                            ? null
                            : () => offline.syncNow(userInitiated: true),
                      ),
                    ),
                  if (entries.isEmpty && offline?.unreadable != true)
                    const ScheduleMessageCard(
                      title: 'Nothing saved on this phone',
                    ),
                  for (final punch in entries.reversed)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: _SavedActionRow(
                        punch: punch,
                        onDismiss: punch.isPending
                            ? null
                            : () => offline!.dismiss(punch.idempotencyKey),
                      ),
                    ),
                  if (entries.isNotEmpty)
                    Center(
                      child: TextButton(
                        key: const ValueKey('offline-discard-all'),
                        style: TextButton.styleFrom(
                          foregroundColor: ScheduleTokens.errorText,
                        ),
                        onPressed: () => _confirmDiscard(context, offline!),
                        child: const Text('Discard saved actions'),
                      ),
                    ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _SavedActionRow extends StatelessWidget {
  const _SavedActionRow({required this.punch, this.onDismiss});
  final QueuedPunch punch;
  final VoidCallback? onDismiss;

  @override
  Widget build(BuildContext context) {
    final when = DateFormat(
      'EEE d MMM, HH:mm',
    ).format(punch.displayAt.toLocal());
    final title = '${OfflineMessages.action(punch.entry.type)} · $when';
    final kind = switch (punch.state) {
      QueuedPunchState.pending => ScheduleMessageKind.warning,
      _ => ScheduleMessageKind.error,
    };
    return ScheduleMessageCard(
      key: ValueKey('saved-action-${punch.idempotencyKey}'),
      title: title,
      message: OfflineMessages.stateLine(punch),
      kind: kind,
      actionLabel: onDismiss == null ? null : 'Dismiss',
      onAction: onDismiss,
    );
  }
}

/// Re-review M: a visible way out when saved actions can never be sent. Asks first; discarded = never sent, and the
/// manager is not told (D18).
Future<void> _confirmDiscard(
  BuildContext context,
  OfflineSyncController offline,
) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (dialog) => AlertDialog(
      key: const ValueKey('offline-discard-confirm'),
      title: const Text('Discard saved actions?'),
      content: const Text(OfflineMessages.discardConfirm),
      actions: [
        TextButton(
          key: const ValueKey('offline-discard-cancel'),
          onPressed: () => Navigator.pop(dialog, false),
          child: const Text('Keep them'),
        ),
        TextButton(
          key: const ValueKey('offline-discard-confirm-yes'),
          onPressed: () => Navigator.pop(dialog, true),
          child: const Text('Discard'),
        ),
      ],
    ),
  );
  if (confirmed != true) return;
  try {
    await offline.discardAll();
  } catch (_) {
    if (context.mounted) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(content: Text(OfflineMessages.unreadable)),
      );
    }
  }
}
