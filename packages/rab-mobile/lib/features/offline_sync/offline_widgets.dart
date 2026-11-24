import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'offline_entry.dart';
import 'offline_messages.dart';
import 'offline_sync_controller.dart';
import 'saved_actions_screen.dart';

/// The clock card for a punch saved on this phone and not yet confirmed (DESIGN §3.6, D10): a FIXED time and the
/// words "saved on this phone, not yet confirmed". It has no timer and never ticks: a running timer must come from the
/// server (`serverNow − clockInAt`, CLAUDE.md), and nothing has been confirmed yet.
class OfflinePendingCard extends StatelessWidget {
  const OfflinePendingCard({super.key, required this.punch});
  final QueuedPunch punch;

  @override
  Widget build(BuildContext context) => Column(
    key: const ValueKey('offline-pending-card'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      Text('SAVED ON THIS PHONE', style: ScheduleType.timerLabel),
      const SizedBox(height: 10),
      Text(
        OfflineMessages.fixedCard(punch),
        key: const ValueKey('offline-pending-time'),
        style: ScheduleType.cardTitle.copyWith(fontSize: 28),
      ),
      const SizedBox(height: 14),
      Container(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
        decoration: BoxDecoration(
          color: ScheduleTokens.toastWarningFill,
          borderRadius: BorderRadius.circular(999),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const Icon(
              Icons.cloud_off_outlined,
              size: 16,
              color: ScheduleTokens.warningText,
            ),
            const SizedBox(width: 6),
            Flexible(
              child: Text(
                OfflineMessages.notConfirmed,
                style: ScheduleType.badge.copyWith(
                  color: ScheduleTokens.warningText,
                ),
              ),
            ),
          ],
        ),
      ),
    ],
  );
}

/// The amber "saved on this phone" banner, or a red one when a saved action needs the staff member's attention.
/// Renders nothing without an offline controller (every presentation but staff) or with nothing saved.
class OfflineQueueBanner extends StatelessWidget {
  const OfflineQueueBanner({super.key});

  @override
  Widget build(BuildContext context) {
    final offline = context.watch<OfflineSyncController?>();
    if (offline == null) return const SizedBox.shrink();
    void open() => Navigator.of(context).push(SavedActionsScreen.route());
    if (offline.needsAttention) {
      return ScheduleMessageCard(
        key: const ValueKey('offline-attention-banner'),
        title: 'A saved action needs your attention',
        message: offline.unreadable
            ? OfflineMessages.unreadable
            : OfflineMessages.managerCanSee,
        kind: ScheduleMessageKind.error,
        actionLabel: 'View',
        onAction: open,
      );
    }
    final latest = offline.pending.lastOrNull;
    if (latest == null) {
      final notice = offline.notices.firstOrNull;
      if (notice == null) return const SizedBox.shrink();
      return ScheduleMessageCard(
        key: const ValueKey('offline-notice-banner'),
        title: 'Sent',
        message: notice,
        actionLabel: 'OK',
        onAction: () => offline.dismissNotice(notice),
      );
    }
    return ScheduleMessageCard(
      key: const ValueKey('offline-queued-banner'),
      title: offline.pendingCount == 1
          ? 'Saved on this phone'
          : '${offline.pendingCount} actions saved on this phone',
      message: OfflineMessages.queuedBanner(latest),
      kind: ScheduleMessageKind.warning,
      actionLabel: 'View',
      onAction: open,
    );
  }
}
