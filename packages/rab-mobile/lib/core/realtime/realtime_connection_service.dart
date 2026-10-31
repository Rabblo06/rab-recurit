import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import '../api/api_client.dart';
import '../auth/auth_provider.dart';
import '../../features/home/attendance_provider.dart';
import '../../features/notifications/notifications_provider.dart';
import '../../features/offers/offers_provider.dart';
import '../../features/venue_manager/venue_manager_provider.dart';
import 'realtime_envelope.dart';

enum RealtimeConnectionStatus {
  connecting,
  connected,
  reconnecting,
  offline,

  /// 204 (`REALTIME_ENABLED=false`, the default) or 404 (no route): never
  /// retried for the life of this service, i.e. until a new session/identity.
  disabled,

  /// Refused (401/403 after one shared refresh) or the identity changed.
  stopped,
}

/// Timings of [RealtimeConnectionService] (tests shorten nothing: they run on
/// fake time).
class RealtimeTimings {
  const RealtimeTimings({
    this.keepalive = const Duration(seconds: 25),
    this.baseBackoff = const Duration(seconds: 1),
    this.maxBackoff = const Duration(seconds: 30),
    this.sustainedConnection = const Duration(seconds: 60),
    this.defaultRetryAfter = const Duration(seconds: 30),
    this.coalesce = const Duration(milliseconds: 500),
  });

  final Duration keepalive;
  final Duration baseBackoff;
  final Duration maxBackoff;
  final Duration sustainedConnection;
  final Duration defaultRetryAfter;
  final Duration coalesce;

  /// No byte (event or `: keepalive` comment) for this long → reconnect.
  Duration get watchdog => keepalive * 2;
}

/// What a set of realtime event types refreshes. Only the providers' existing
/// reads; nothing from an event is ever written into application state.
enum RealtimeRefresh { offers, attendance, history, venueManager, unreadCount }

Set<RealtimeRefresh> realtimeRefreshesFor(
  Set<String> types, {
  required bool staff,
  required bool venueManager,
}) {
  final result = <RealtimeRefresh>{};
  for (final type in types) {
    if (type == 'notification.created') result.add(RealtimeRefresh.unreadCount);
    if (staff) {
      if (type.startsWith('offer.') ||
          type == 'shift.updated' ||
          type == 'shift.cancelled') {
        result.add(RealtimeRefresh.offers);
      }
      if (type == 'attendance.changed') {
        result
          ..add(RealtimeRefresh.attendance)
          ..add(RealtimeRefresh.history);
      }
      if (type == 'payroll.record_changed') result.add(RealtimeRefresh.history);
    }
    if (venueManager &&
        (type.startsWith('offer.') ||
            type.startsWith('shift.') ||
            type.startsWith('shift_request.') ||
            type == 'attendance.changed')) {
      result.add(RealtimeRefresh.venueManager);
    }
  }
  return result;
}

/// The Flutter foreground realtime client (Phase C1b): `GET
/// /rest/v1/realtime/stream` (Server-Sent Events) on the same session and
/// bearer token as every other request (`ApiClient.openStream`), mirroring the
/// iOS `RealtimeClient` and the web `realtime-client.ts`.
///
/// - 204 (`REALTIME_ENABLED=false`) / 404 / a 200 that is not an event stream
///   = disabled: one request, then silence until a new session/identity (this
///   service lives in the identity-keyed `MultiProvider` in `app.dart`).
/// - 401/403: ONE refresh through the shared path (`GET /auth/me`, which runs
///   `ApiClient`'s single-flight refresh-or-expire); refused again → stopped.
/// - 429: waits `Retry-After` (default 30 s) plus up to 20 % jitter.
/// - Any other failure or a dropped stream: backoff 1 s ×2 up to 30 s at
///   50–100 % jitter, reset only after a connection that stayed up ≥ 60 s.
/// - Watchdog: no byte for 2 × keepalive (50 s) → dropped and reconnected.
/// - Foreground only (closed on paused/detached, reopened on resume; the
///   shells run their own resume reconcile). After a reconnect that followed a
///   failure or a drop, [reconcile] refetches what may have been missed.
/// - The stream request is background traffic (`X-Crewflow-Background: 1`).
/// - Events: validated envelope, `targetUserId` must be the signed-in user,
///   deduplicated (last 200 ids), coalesced ~0.5 s, then only the providers'
///   existing refreshes run ([realtimeRefreshesFor]), background-flagged.
/// - While live, the polls it covers (Sent Shifts first page, notifications,
///   staff reconcile) slow to `realtimeFallbackPollInterval`; they revert as
///   soon as it is not live ([isLive] + `notifyListeners`).
/// - The session generation is re-checked before every connect and dispatch;
///   a changed identity stops this service for good.
class RealtimeConnectionService extends ChangeNotifier
    with WidgetsBindingObserver {
  RealtimeConnectionService({
    required ApiClient api,
    required AuthProvider auth,
    OffersProvider? offers,
    AttendanceProvider? attendance,
    VenueManagerProvider? venueManager,
    NotificationsProvider? notifications,
    RealtimeTimings timings = const RealtimeTimings(),
    Random? random,
  }) : _api = api,
       _auth = auth,
       _offers = offers,
       _attendance = attendance,
       _venueManager = venueManager,
       _notifications = notifications,
       _timings = timings,
       _random = random ?? Random(),
       _generation = auth.sessionGeneration {
    WidgetsBinding.instance.addObserver(this);
    unawaited(_connect());
  }

  static const dedupeWindow = 200;
  static const streamPath = '/realtime/stream';

  final ApiClient _api;
  final AuthProvider _auth;
  final OffersProvider? _offers;
  final AttendanceProvider? _attendance;
  final VenueManagerProvider? _venueManager;
  final NotificationsProvider? _notifications;
  final RealtimeTimings _timings;
  final Random _random;
  final int _generation;

  RealtimeConnectionStatus _status = RealtimeConnectionStatus.offline;
  RealtimeConnectionStatus get status => _status;
  bool get isLive => _status == RealtimeConnectionStatus.connected;

  /// Consecutive failed / short-lived connections (drives the backoff).
  int get attempt => _attempt;

  /// The last wait before a reconnect (tests and diagnostics).
  Duration? lastDelay;

  StreamSubscription<String>? _subscription;
  Timer? _reconnectTimer;
  Timer? _watchdog;
  Timer? _dispatchTimer;

  /// Fires once the current connection has stayed up long enough to reset
  /// the backoff (a Timer, not a Stopwatch: it follows the app's clock).
  Timer? _sustainedTimer;
  bool _sustained = false;
  int _attempt = 0;
  bool _disposed = false;
  bool _backgrounded = false;
  bool _authRetried = false;
  bool _needsReconcile = false;
  bool _connecting = false;
  final Set<String> _pendingTypes = {};

  final Queue<String> _seenEventIds = Queue<String>();
  final Set<String> _seenEventIdSet = <String>{};

  bool get _ended =>
      _status == RealtimeConnectionStatus.disabled ||
      _status == RealtimeConnectionStatus.stopped;
  bool get _canConnect => !_disposed && !_backgrounded && !_ended;

  void _setStatus(RealtimeConnectionStatus next) {
    if (_disposed || _status == next) return;
    final wasLive = isLive;
    _status = next;
    if (wasLive != isLive) _notifications?.setRealtimeLive(isLive);
    notifyListeners();
  }

  bool _identityChanged() {
    if (_auth.sessionGeneration == _generation) return false;
    _end(RealtimeConnectionStatus.stopped);
    return true;
  }

  Future<void> _connect() async {
    if (!_canConnect || _connecting || _subscription != null) return;
    if (_identityChanged()) return;
    _connecting = true;
    _setStatus(RealtimeConnectionStatus.connecting);
    final http.StreamedResponse response;
    try {
      if (await _api.getAccessToken() == null) {
        // No credential at all: AuthProvider owns re-authentication.
        _connecting = false;
        _end(RealtimeConnectionStatus.stopped);
        return;
      }
      response = await _api.openStream(streamPath);
    } catch (_) {
      _connecting = false;
      if (_canConnect && !_identityChanged()) _retry(_backoff());
      return;
    }
    _connecting = false;
    if (!_canConnect || _identityChanged()) {
      _drain(response);
      return;
    }
    switch (response.statusCode) {
      case 200
          when (response.headers['content-type'] ?? '').contains(
            'text/event-stream',
          ):
        _authRetried = false;
        _consume(response);
      case 200 || 204 || 404:
        // Disabled (or not an event stream at all): never hammer it.
        _drain(response);
        _end(RealtimeConnectionStatus.disabled);
      case 401 || 403:
        _drain(response);
        await _refreshOnceThenRetry();
      case 429:
        _drain(response);
        final parsed =
            parseRetryAfter(response.headers['retry-after']) ??
            _timings.defaultRetryAfter;
        final wait = parsed < minRetryAfter ? minRetryAfter : parsed;
        _retry(wait + _scale(wait, _random.nextDouble() * 0.2));
      default:
        _drain(response);
        _retry(_backoff());
    }
  }

  /// One refresh through the shared path; a second refusal stops for good.
  Future<void> _refreshOnceThenRetry() async {
    if (_authRetried) {
      _end(RealtimeConnectionStatus.stopped);
      return;
    }
    _authRetried = true;
    try {
      // `ApiClient` refreshes on 401 (single-flight) and, when the refresh is
      // refused, ends the session itself (`onSessionExpired`).
      await _api.get('/auth/me', background: true);
    } catch (_) {
      _end(RealtimeConnectionStatus.stopped);
      return;
    }
    if (_canConnect && !_identityChanged()) unawaited(_connect());
  }

  void _consume(http.StreamedResponse response) {
    _sustained = false;
    _sustainedTimer?.cancel();
    _sustainedTimer = Timer(
      _timings.sustainedConnection,
      () => _sustained = true,
    );
    _setStatus(RealtimeConnectionStatus.connected);
    if (_needsReconcile) {
      _needsReconcile = false;
      reconcile();
    }
    _armWatchdog();
    final parser = SseStreamParser();
    _subscription = response.stream
        .transform(utf8.decoder)
        .listen(
          (chunk) {
            _armWatchdog();
            for (final frame in parser.addChunk(chunk)) {
              _handleFrame(frame);
            }
          },
          onError: (Object _) => _dropped(),
          onDone: _dropped,
          cancelOnError: true,
        );
  }

  void _armWatchdog() {
    _watchdog?.cancel();
    _watchdog = Timer(_timings.watchdog, () {
      unawaited(_subscription?.cancel());
      _dropped();
    });
  }

  void _dropped() {
    if (_subscription == null) return;
    _subscription = null;
    _watchdog?.cancel();
    _sustainedTimer?.cancel();
    if (!_canConnect) return;
    if (_sustained) _attempt = 0;
    if (_identityChanged()) return;
    _retry(_backoff());
  }

  Duration _backoff() {
    _attempt++;
    final step = _timings.baseBackoff * pow(2, min(_attempt - 1, 20)).toInt();
    final base = step > _timings.maxBackoff ? _timings.maxBackoff : step;
    // 50–100 % of the step: phones that lost the server together do not come
    // back together.
    return _scale(base, 0.5 + _random.nextDouble() * 0.5);
  }

  void _retry(Duration delay) {
    _needsReconcile = true;
    lastDelay = delay;
    _setStatus(RealtimeConnectionStatus.reconnecting);
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(delay, () => unawaited(_connect()));
  }

  static Duration _scale(Duration d, double factor) =>
      Duration(microseconds: (d.inMicroseconds * factor).round());

  void _drain(http.StreamedResponse response) =>
      unawaited(response.stream.drain<void>().catchError((Object _) {}));

  void _close() {
    _reconnectTimer?.cancel();
    _watchdog?.cancel();
    _sustainedTimer?.cancel();
    _dispatchTimer?.cancel();
    _dispatchTimer = null;
    _pendingTypes.clear();
    final subscription = _subscription;
    _subscription = null;
    unawaited(subscription?.cancel());
  }

  void _end(RealtimeConnectionStatus status) {
    _close();
    _setStatus(status);
  }

  void _handleFrame(SseFrame frame) {
    if (!_canConnect || _identityChanged()) return;
    final envelope = parseRealtimeEnvelope(frame.data);
    if (envelope == null) return; // malformed / unknown: dropped, never crashes
    // The server already addresses the recipient; this is defence in depth.
    final userId = _auth.user?.id;
    if (userId == null ||
        envelope.targetUserId?.toLowerCase() != userId.toLowerCase()) {
      return;
    }
    if (!_rememberEventId(envelope.eventId)) return; // at-least-once duplicate
    _pendingTypes.add(envelope.type);
    _dispatchTimer ??= Timer(_timings.coalesce, _dispatch);
  }

  /// Bounded FIFO dedupe; false for an id already seen.
  bool _rememberEventId(String eventId) {
    final key = eventId.toLowerCase();
    if (!_seenEventIdSet.add(key)) return false;
    _seenEventIds.add(key);
    if (_seenEventIds.length > dedupeWindow) {
      _seenEventIdSet.remove(_seenEventIds.removeFirst());
    }
    return true;
  }

  void _dispatch() {
    _dispatchTimer = null;
    final types = Set<String>.of(_pendingTypes);
    _pendingTypes.clear();
    if (types.isEmpty || _disposed || _identityChanged()) return;
    _run(
      realtimeRefreshesFor(
        types,
        staff: _offers != null || _attendance != null,
        venueManager: _venueManager != null,
      ),
    );
  }

  /// Every refresh is an existing provider read, background-flagged, and
  /// single-flight inside the provider (a burst costs at most one extra run).
  void _run(Set<RealtimeRefresh> refreshes, {bool background = true}) {
    for (final refresh in refreshes) {
      switch (refresh) {
        case RealtimeRefresh.offers:
          unawaited(_offers?.load(silent: true, background: background));
        case RealtimeRefresh.attendance:
          unawaited(
            _attendance?.refreshActive(silent: true, background: background),
          );
        case RealtimeRefresh.history:
          unawaited(
            _attendance?.loadHistory(silent: true, background: background),
          );
        case RealtimeRefresh.venueManager:
          unawaited(
            _venueManager?.refresh(silent: true, background: background),
          );
        case RealtimeRefresh.unreadCount:
          unawaited(_notifications?.refreshUnreadCount(background: background));
      }
    }
  }

  /// Refetches everything this identity shows (after a reconnect that
  /// followed a drop, or a push notification): the stream cannot have
  /// delivered what happened while it was down. [background] is false only
  /// for a notification TAP (real user activity); a reconnect or a push
  /// arrival never slides the session's idle window.
  void reconcile({bool background = true}) {
    if (_disposed || _identityChanged()) return;
    unawaited(
      _offers?.load(silent: true, background: background, joinInFlight: true),
    );
    _run(background: background, {
      if (_attendance != null) ...[
        RealtimeRefresh.attendance,
        RealtimeRefresh.history,
      ],
      if (_venueManager != null) RealtimeRefresh.venueManager,
      RealtimeRefresh.unreadCount,
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    switch (state) {
      case AppLifecycleState.paused:
      case AppLifecycleState.detached:
        _enterBackground();
      case AppLifecycleState.resumed:
        _leaveBackground();
      case AppLifecycleState.inactive:
      case AppLifecycleState.hidden:
        break;
    }
  }

  void _enterBackground() {
    if (_disposed || _backgrounded) return;
    _backgrounded = true;
    _close();
    if (!_ended) _setStatus(RealtimeConnectionStatus.offline);
  }

  void _leaveBackground() {
    if (_disposed || !_backgrounded) return;
    _backgrounded = false;
    // The shells reconcile on resume themselves; the backoff starts over.
    _attempt = 0;
    _needsReconcile = false;
    unawaited(_connect());
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _close();
    super.dispose();
  }
}
