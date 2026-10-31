import 'dart:async';
import 'dart:io';

import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter/foundation.dart';

import '../api/api_client.dart';
import '../../features/notifications/notifications_provider.dart';
import 'push_device_store.dart';

/// The OS/Firebase side of push. Production: [FirebasePushMessaging]; tests
/// inject a fake (no Firebase credentials are ever needed in tests).
abstract class PushMessaging {
  /// False when push cannot work here (not Android, or Firebase is not
  /// configured — there is no real Firebase project yet).
  Future<bool> initialize();

  /// The CURRENT permission, without prompting.
  Future<bool> isPermitted();

  /// Shows the system prompt. Only ever from an explicit user action.
  Future<bool> requestPermission();

  Future<String?> getToken();
  Stream<String> get onTokenRefresh;

  /// A notification arrived in the foreground or was opened (tap, including
  /// the one that launched the app). Never carries data to the app.
  Stream<PushActivity> get onActivity;
}

/// [arrived] is not user activity (background refetch, never slides the idle
/// window); [opened] (a tap) is.
enum PushActivity { arrived, opened }

/// Android-only FCM. iOS uses the native app's direct APNs path; this Flutter
/// project has no `ios/` folder. Every call is a safe no-op where Firebase is
/// not configured: a missing config never blocks login, logout or anything.
class FirebasePushMessaging implements PushMessaging {
  @override
  Future<bool> initialize() async {
    if (kIsWeb || !Platform.isAndroid) return false;
    try {
      await Firebase.initializeApp();
      return true;
    } catch (_) {
      return false;
    }
  }

  @override
  Future<bool> isPermitted() async {
    final settings = await FirebaseMessaging.instance.getNotificationSettings();
    return settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<bool> requestPermission() async {
    final settings = await FirebaseMessaging.instance.requestPermission();
    return settings.authorizationStatus == AuthorizationStatus.authorized ||
        settings.authorizationStatus == AuthorizationStatus.provisional;
  }

  @override
  Future<String?> getToken() => FirebaseMessaging.instance.getToken();

  @override
  Stream<String> get onTokenRefresh =>
      FirebaseMessaging.instance.onTokenRefresh;

  @override
  Stream<PushActivity> get onActivity {
    final controller = StreamController<PushActivity>();
    final subscriptions = <StreamSubscription<RemoteMessage>>[];
    controller
      ..onListen = () {
        subscriptions
          ..add(
            FirebaseMessaging.onMessage.listen(
              (_) => controller.add(PushActivity.arrived),
            ),
          )
          ..add(
            FirebaseMessaging.onMessageOpenedApp.listen(
              (_) => controller.add(PushActivity.opened),
            ),
          );
        FirebaseMessaging.instance.getInitialMessage().then((message) {
          if (message != null && !controller.isClosed) {
            controller.add(PushActivity.opened);
          }
        }, onError: (Object _) {});
      }
      ..onCancel = () async {
        for (final s in subscriptions) {
          await s.cancel();
        }
      };
    return controller.stream;
  }
}

/// Registers this device for push (`POST /rest/v1/push/devices`) for the
/// signed-in identity and deactivates it on sign-out. Lives and dies with the
/// identity-scoped `MultiProvider` in `app.dart` (created eagerly, Phase C1b).
///
/// - Opt-in only: on start it registers ONLY if notification permission was
///   already granted; it never shows the system prompt by itself. [enable] is
///   the explicit "Turn on notifications" action (prompt, then register).
/// - Identity fencing: the session generation is captured at construction;
///   nothing is registered once it changed (logout / account switch), so a
///   registration can never survive into another account.
/// - Sign-out: the device id is handed to `ApiClient` right before the
///   registration request, so `/auth/logout` names it (`pushDeviceId`, the
///   server deactivates exactly this device in the logout transaction), and
///   [dispose] also calls `POST /push/devices/:uuid/deactivate` (best effort).
/// - A notification (foreground arrival or tap) never writes its payload
///   anywhere: it only refetches — the notifications list plus [onActivity]
///   (the realtime client's reconcile). Presentation stays the server's
///   generic text; the app adds nothing to the lock screen.
class PushRegistrationService extends ChangeNotifier {
  PushRegistrationService({
    required ApiClient api,
    NotificationsProvider? notifications,
    void Function({required bool background})? onActivity,
    PushDeviceStore? deviceStore,
    PushMessaging? messaging,
  }) : _api = api,
       _notifications = notifications,
       _onActivity = onActivity,
       _deviceStore = deviceStore ?? PushDeviceStore(),
       _messaging = messaging ?? FirebasePushMessaging(),
       _generation = api.sessionGeneration {
    unawaited(_start(prompt: false));
  }

  final ApiClient _api;
  final NotificationsProvider? _notifications;
  final void Function({required bool background})? _onActivity;
  final PushDeviceStore _deviceStore;
  final PushMessaging _messaging;
  final int _generation;

  bool _disposed = false;
  bool _starting = false;
  String? _registeredDeviceId;
  StreamSubscription<String>? _tokenRefreshSubscription;
  StreamSubscription<PushActivity>? _activitySubscription;

  /// The device id registered for this session, if any (tests, diagnostics).
  String? get registeredDeviceId => _registeredDeviceId;

  bool get _current => !_disposed && _api.sessionGeneration == _generation;

  /// The explicit "Turn on notifications" action: prompts, then registers.
  /// Returns whether this device is registered afterwards.
  Future<bool> enable() async {
    await _start(prompt: true);
    return _registeredDeviceId != null;
  }

  Future<void> _start({required bool prompt}) async {
    if (_starting || _registeredDeviceId != null || !_current) return;
    _starting = true;
    try {
      if (!await _messaging.initialize() || !_current) return;
      final permitted = prompt
          ? await _messaging.requestPermission()
          : await _messaging.isPermitted();
      if (!permitted || !_current) return;
      final token = await _messaging.getToken();
      if (token == null || !_current) return;
      final deviceId = await _deviceStore.getOrCreateDeviceId();
      if (!await _send(deviceId, token)) return;
      _registeredDeviceId = deviceId;
      _tokenRefreshSubscription = _messaging.onTokenRefresh.listen((fresh) {
        unawaited(_send(deviceId, fresh));
      });
      _activitySubscription = _messaging.onActivity.listen((activity) {
        if (!_current) return;
        // An arrival is not the user: background traffic only, so a stream of
        // pushes cannot keep an unattended session alive. A tap is the user.
        final background = activity == PushActivity.arrived;
        unawaited(
          _notifications
              ?.load(background: background)
              .catchError((Object _) {}),
        );
        _onActivity?.call(background: background);
      });
      notifyListeners();
    } catch (_) {
      // Push is best-effort; Firebase is not configured in any build yet.
    } finally {
      _starting = false;
    }
  }

  /// One registration upsert, only for the identity this service belongs to.
  Future<bool> _send(String deviceId, String token) async {
    if (!_current) return false;
    // Named in /auth/logout from now on, even if this request is still on
    // the wire when the user signs out.
    _api.pushDeviceIdForLogout = deviceId;
    try {
      await _api.post(
        '/push/devices',
        body: {'deviceId': deviceId, 'platform': 'android', 'pushToken': token},
      );
      return _current;
    } catch (_) {
      // Best-effort — a failed registration retries on the next start.
      return false;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_tokenRefreshSubscription?.cancel());
    unawaited(_activitySubscription?.cancel());
    final deviceId = _registeredDeviceId;
    // Only while this session's tokens still exist (sign-out disposes this
    // before the tokens are cleared); never under another identity.
    if (deviceId != null && _api.sessionGeneration == _generation) {
      unawaited(
        _api
            .post('/push/devices/$deviceId/deactivate')
            .catchError((Object _) {}),
      );
    }
    super.dispose();
  }
}
