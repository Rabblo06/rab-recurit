import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/widgets.dart';

import '../api/api_client.dart';
import '../../features/notifications/notifications_provider.dart';
import 'push_device_store.dart';

/// Stage 6 — registers this device for push with the backend
/// (`POST /rest/v1/push/devices`) and deregisters it on logout. Lives and
/// dies with the SAME identity-scoped `MultiProvider` key `app.dart` already
/// uses for every other per-session provider — registration happens once in
/// the constructor (fresh login, or app restart landing straight back on an
/// already-authenticated identity), deregistration happens in [dispose]
/// (logout tears down this whole subtree; by the time Provider disposes it,
/// `AuthProvider.logout()` has not yet cleared tokens — that happens later
/// in its own method body, after the best-effort `/auth/logout` network
/// call — so the access token this needs is still valid).
///
/// ANDROID ONLY today. This Flutter project has no `ios/` platform folder at
/// all (no Xcode project exists on this machine), and the owner's approved
/// architecture routes iOS through a DIRECT Apple APNs integration, never
/// through Firebase — wiring that up needs `flutter create --platforms=ios`
/// plus native Swift registration code (`UNUserNotificationCenter`,
/// `didRegisterForRemoteNotificationsWithDeviceToken`), neither of which
/// exists yet. Every method here is a safe no-op on iOS and everywhere
/// Firebase isn't actually configured (there is no real Firebase project —
/// Stage 6 explicitly forbids creating one without approval): a missing
/// config must never block login, logout, or anything else in the app. This
/// is "implemented," not "verified against a real device."
///
/// Payload handling never writes push content into state: a foreground
/// message or an app resume (which also covers tapping a background
/// notification) both just call [NotificationsProvider.load] — the same
/// "go refetch the authoritative list" idiom `RealtimeConnectionService`
/// already uses, never the push payload's own fields. Per-notification-type
/// deep-linking (opening a specific offer/shift from a tapped notification)
/// is NOT implemented — scoped out of this pass, left as a documented
/// follow-up in the Stage 6 report.
class PushRegistrationService extends ChangeNotifier
    with WidgetsBindingObserver {
  PushRegistrationService({
    required ApiClient api,
    NotificationsProvider? notifications,
    PushDeviceStore? deviceStore,
  }) : _api = api,
       _notifications = notifications,
       _deviceStore = deviceStore ?? PushDeviceStore() {
    WidgetsBinding.instance.addObserver(this);
    unawaited(_register());
  }

  final ApiClient _api;
  final NotificationsProvider? _notifications;
  final PushDeviceStore _deviceStore;

  bool _disposed = false;
  String? _registeredDeviceId;
  StreamSubscription<String>? _tokenRefreshSubscription;
  StreamSubscription<RemoteMessage>? _foregroundMessageSubscription;

  Future<void> _register() async {
    if (!Platform.isAndroid) return; // iOS: see class doc comment.
    try {
      await Firebase.initializeApp();
      final messaging = FirebaseMessaging.instance;
      final settings = await messaging.requestPermission();
      if (_disposed) return;
      if (settings.authorizationStatus == AuthorizationStatus.denied) return;

      final token = await messaging.getToken();
      if (_disposed || token == null) return;

      final deviceId = await _deviceStore.getOrCreateDeviceId();
      if (_disposed) return;
      await _sendRegistration(deviceId, token);
      _registeredDeviceId = deviceId;

      _tokenRefreshSubscription = messaging.onTokenRefresh.listen((refreshed) {
        unawaited(_sendRegistration(deviceId, refreshed));
      });
      _foregroundMessageSubscription = FirebaseMessaging.onMessage.listen((_) {
        unawaited(_notifications?.load());
      });
    } catch (_) {
      // Push is best-effort — see class doc comment. No real Firebase
      // project exists yet, so this path is expected to fail today.
    }
  }

  Future<void> _sendRegistration(String deviceId, String token) async {
    try {
      await _api.post(
        '/push/devices',
        body: {'deviceId': deviceId, 'platform': 'android', 'pushToken': token},
      );
    } catch (_) {
      // Best-effort — a failed registration retries on the next cold start.
    }
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      // Covers both "tapped a background push" and any other reason the app
      // came back to the foreground — same reasoning as
      // `RealtimeConnectionService._leaveBackground`: a push cannot be
      // assumed to have arrived while this provider was mounted, so the
      // authoritative list is refetched directly rather than waited for.
      unawaited(_notifications?.load());
    }
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    unawaited(_tokenRefreshSubscription?.cancel());
    unawaited(_foregroundMessageSubscription?.cancel());
    final deviceId = _registeredDeviceId;
    if (deviceId != null) {
      unawaited(_api.post('/push/devices/$deviceId/deactivate').catchError((_) {}));
    }
    super.dispose();
  }
}
