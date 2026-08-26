import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/models/notification_item.dart';
import '../../core/theme/tokens.dart';
import 'notifications_provider.dart';

class NotificationsScreen extends StatefulWidget {
  const NotificationsScreen({super.key});

  @override
  State<NotificationsScreen> createState() => _NotificationsScreenState();
}

class _NotificationsScreenState extends State<NotificationsScreen> {
  @override
  void initState() {
    super.initState();
    // Deferred to after the first frame — `IndexedStack` mounts every tab
    // eagerly, so this `initState` can run while an unrelated ancestor
    // (e.g. another tab's Provider scope) is still mid-build; calling
    // `load()`'s synchronous first `notifyListeners()` at that point throws
    // "setState() called during build".
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<NotificationsProvider>().load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final provider = context.watch<NotificationsProvider>();

    if (provider.isLoading) {
      return Scaffold(
        backgroundColor: colors.bgApp,
        appBar: AppBar(title: const Text('Notifications')),
        body: Center(child: CircularProgressIndicator(color: colors.accent)),
      );
    }

    return Scaffold(
      backgroundColor: colors.bgApp,
      appBar: AppBar(
        title: const Text('Notifications'),
        actions: [
          if (provider.unreadCount > 0)
            TextButton(
              onPressed: provider.markAllRead,
              child: const Text('Mark all read'),
            ),
        ],
      ),
      body: SafeArea(
        child: RefreshIndicator(
          color: colors.accent,
          onRefresh: provider.load,
          child: ListView(
            padding: const EdgeInsets.all(AppSpace.s5),
            children: [
              if (provider.notifications.isEmpty)
                Padding(
                  padding: const EdgeInsets.only(top: AppSpace.s8),
                  child: Text(
                    'No notifications yet.',
                    textAlign: TextAlign.center,
                    style: text.bodyMobile.copyWith(color: colors.textSecondary),
                  ),
                ),
              ...provider.notifications.map((n) => _NotificationTile(
                    notification: n,
                    onTap: n.isUnread ? () => provider.markRead(n.id) : null,
                  )),
            ],
          ),
        ),
      ),
    );
  }
}

class _NotificationTile extends StatelessWidget {
  const _NotificationTile({required this.notification, this.onTap});

  final NotificationItem notification;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = context.colors;
    final text = context.text;
    final dateFmt = DateFormat('d MMM, HH:mm');
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(AppRadius.md),
      child: Container(
        margin: const EdgeInsets.only(bottom: AppSpace.s3),
        padding: const EdgeInsets.all(AppSpace.s4),
        decoration: BoxDecoration(
          color: notification.isUnread ? colors.accentSoft.withValues(alpha: 0.35) : colors.bgSurface,
          borderRadius: BorderRadius.circular(AppRadius.md),
          border: Border.all(color: colors.border),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(notification.title, style: text.bodyMobile.copyWith(fontWeight: FontWeight.w600)),
            const SizedBox(height: AppSpace.s1),
            Text(notification.message, style: text.bodyMobile.copyWith(color: colors.textSecondary)),
            const SizedBox(height: AppSpace.s2),
            Text(dateFmt.format(notification.createdAt), style: text.label.copyWith(color: colors.textTertiary)),
          ],
        ),
      ),
    );
  }
}
