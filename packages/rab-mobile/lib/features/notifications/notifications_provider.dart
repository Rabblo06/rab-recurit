import 'dart:async';

import 'package:flutter/foundation.dart';

import '../../core/api/api_client.dart';
import '../../core/models/notification_item.dart';
import '../../core/polling/poll_scheduler.dart';

/// In-app only — polling, no push (mirrors the web console's
/// `NotificationBell.tsx` scope decision this session). Polls unread-count
/// so the badge stays current while the user is on any screen: every
/// [pollInterval] ±20 % (Phase C1), only while the app is in the foreground
/// (one immediate refresh on resume), as background traffic
/// (`X-Crewflow-Background`), with 429/backoff from [PollScheduler].
class NotificationsProvider extends ChangeNotifier {
  NotificationsProvider(this._api) {
    unawaited(_refreshUnreadCount().catchError((Object _) {}));
    _poll = PollScheduler(
      interval: pollInterval,
      identity: () => _api.sessionGeneration,
      task: (trigger) => _refreshUnreadCount(background: trigger.isBackground),
    )..start();
  }

  static const pollInterval = Duration(seconds: 60);

  final ApiClient _api;
  late final PollScheduler _poll;
  bool _disposed = false;

  List<NotificationItem> notifications = [];
  bool isLoading = true;
  int unreadCount = 0;

  /// [background]: a push ARRIVAL (`X-Crewflow-Background`); a tap or the
  /// inbox screen is the user's own request.
  Future<void> load({bool background = false}) async {
    isLoading = true;
    notifyListeners();
    try {
      final data =
          await _api.get('/notifications', background: background)
              as List<dynamic>;
      notifications = data
          .map((e) => NotificationItem.fromJson(e as Map<String, dynamic>))
          .toList();
      unreadCount = notifications.where((n) => n.isUnread).length;
    } finally {
      isLoading = false;
      notifyListeners();
    }
  }

  /// Best-effort for the UI (a failed poll keeps the last count); the error
  /// still reaches the scheduler so it can back off.
  Future<void> _refreshUnreadCount({bool background = false}) async {
    final data =
        await _api.get('/notifications/unread-count', background: background)
            as Map<String, dynamic>;
    if (_disposed) return;
    unreadCount = data['count'] as int;
    notifyListeners();
  }

  /// Realtime `notification.created` (background traffic). Never throws.
  Future<void> refreshUnreadCount({bool background = false}) =>
      _refreshUnreadCount(background: background).catchError((Object _) {});

  /// While the realtime stream is live the badge poll is only a safety net.
  void setRealtimeLive(bool live) =>
      _poll.setInterval(live ? realtimeFallbackPollInterval : pollInterval);

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
    _disposed = true;
    _poll.dispose();
    super.dispose();
  }
}
