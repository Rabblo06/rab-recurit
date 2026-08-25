import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api/api_client.dart';
import '../../core/models/notification_item.dart';

/// In-app only — polling, no push (mirrors the web console's
/// `NotificationBell.tsx` scope decision this session). Polls unread-count
/// on a timer so the bottom-nav badge stays current even while the user is
/// on a different tab, same cadence as web (30s).
class NotificationsProvider extends ChangeNotifier {
  NotificationsProvider(this._api) {
    _refreshUnreadCount();
    _timer = Timer.periodic(const Duration(seconds: 30), (_) => _refreshUnreadCount());
  }

  final ApiClient _api;
  Timer? _timer;

  List<NotificationItem> notifications = [];
  bool isLoading = true;
  int unreadCount = 0;

  Future<void> load() async {
    isLoading = true;
    notifyListeners();
    try {
      final data = await _api.get('/notifications') as List<dynamic>;
      notifications = data.map((e) => NotificationItem.fromJson(e as Map<String, dynamic>)).toList();
      unreadCount = notifications.where((n) => n.isUnread).length;
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  Future<void> _refreshUnreadCount() async {
    try {
      final data = await _api.get('/notifications/unread-count') as Map<String, dynamic>;
      unreadCount = data['count'] as int;
      notifyListeners();
    } catch (_) {
      // Best-effort — a failed poll shouldn't disrupt the rest of the app.
    }
  }

  Future<void> markRead(String id) async {
    try {
      await _api.post('/notifications/$id/read');
      await load();
    } catch (_) {
      // Best-effort.
    }
  }

  Future<void> markAllRead() async {
    try {
      await _api.post('/notifications/read-all');
      await load();
    } catch (_) {
      // Best-effort.
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }
}
