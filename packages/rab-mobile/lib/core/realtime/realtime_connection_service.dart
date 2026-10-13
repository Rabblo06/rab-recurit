import 'dart:async';
import 'dart:collection';
import 'dart:convert';
import 'dart:math';

import 'package:flutter/widgets.dart';
import 'package:http/http.dart' as http;

import '../api/api_client.dart';
import '../auth/auth_provider.dart';
import '../../features/home/attendance_provider.dart';
import '../../features/offers/offers_provider.dart';
import '../../features/venue_manager/venue_manager_provider.dart';
import 'realtime_envelope.dart';

enum RealtimeConnectionStatus { connecting, connected, reconnecting, offline }

const Duration _defaultBaseBackoff = Duration(seconds: 1);
const Duration _defaultMaxBackoff = Duration(seconds: 30);
const int _dedupWindowSize = 200;

/// Stage 5 — the Flutter foreground real-time client. Connects to the exact
/// same authenticated gateway (`GET /rest/v1/realtime/stream`) the React web
/// console already uses (see `rab-front/src/shared/lib/realtime-client.ts`,
/// same wire format, same envelope, same dedup/backoff shape) — no new
/// backend, no second auth system, no direct Redis connection.
///
/// Lives and dies with the SAME identity-scoped `MultiProvider` key `app.dart`
/// already uses for `OffersProvider`/`AttendanceProvider`/`VenueManagerProvider`
/// (`'${auth.user!.id}:${auth.presentation.name}'`) — logout and account
/// switching are therefore handled for free by Provider's own lifecycle
/// (the whole subtree, this service included, is disposed and a fresh one
/// constructed under the new identity), exactly like every other provider in
/// this app. The generation check in [_handleFrame] is defence in depth for
/// the brief window between an identity change and the next widget rebuild,
/// not the primary teardown mechanism.
///
/// Event routing never writes event data directly into application state —
/// every known event type triggers one of the EXISTING provider refresh
/// methods (`OffersProvider.load`, `VenueManagerProvider.refresh`), the same
/// ones the app's own 30s `app_shell.dart` reconcile timer and resume hooks
/// already call. A late or duplicate event can therefore never restore stale
/// state or create duplicate UI data — the only effect of any event is "go
/// refetch the authoritative list," which is idempotent by construction.
class RealtimeConnectionService extends ChangeNotifier
    with WidgetsBindingObserver {
  RealtimeConnectionService({
    required ApiClient api,
    required AuthProvider auth,
    OffersProvider? offers,
    AttendanceProvider? attendance,
    VenueManagerProvider? venueManager,
    http.Client? httpClient,
    // Test-only overrides — production call sites (app.dart) never pass
    // these, so they always get the real 1s/30s production backoff.
    Duration? baseBackoff,
    Duration? maxBackoff,
  }) : _api = api,
       _auth = auth,
       _offers = offers,
       _attendance = attendance,
       _venueManager = venueManager,
       _http = httpClient ?? http.Client(),
       _baseBackoff = baseBackoff ?? _defaultBaseBackoff,
       _maxBackoff = maxBackoff ?? _defaultMaxBackoff {
    WidgetsBinding.instance.addObserver(this);
    unawaited(_connect());
  }

  final ApiClient _api;
  final AuthProvider _auth;
  final OffersProvider? _offers;
  final AttendanceProvider? _attendance;
  final VenueManagerProvider? _venueManager;
  final http.Client _http;
  final Duration _baseBackoff;
  final Duration _maxBackoff;

  RealtimeConnectionStatus _status = RealtimeConnectionStatus.offline;
  RealtimeConnectionStatus get status => _status;

  StreamSubscription<String>? _subscription;
  Timer? _reconnectTimer;
  int _attempt = 0;
  bool _disposed = false;
  bool _backgrounded = false;
  int _generationAtConnect = -1;

  final Queue<String> _seenEventIds = Queue<String>();
  final Set<String> _seenEventIdSet = <String>{};

  void _setStatus(RealtimeConnectionStatus next) {
    if (_disposed || _status == next) return;
    _status = next;
    notifyListeners();
  }

  Future<void> _connect() async {
    if (_disposed || _backgrounded) return;
    _generationAtConnect = _auth.sessionGeneration;
    _setStatus(RealtimeConnectionStatus.connecting);

    final String? token;
    try {
      token = await _api.getAccessToken();
    } catch (_) {
      _scheduleReconnect();
      return;
    }
    if (_disposed || _backgrounded) return;
    if (token == null) {
      // No credential at all — nothing this service can do; `AuthProvider`
      // owns re-authentication, this just waits for the next identity swap.
      _setStatus(RealtimeConnectionStatus.offline);
      return;
    }
    if (_auth.sessionGeneration != _generationAtConnect) return; // identity moved on while we awaited the token

    try {
      final request = http.Request(
        'GET',
        Uri.parse('${_api.baseUrl}/realtime/stream'),
      );
      // Never a token in the URL/query string (Stage 5 §4.1) — only ever a header.
      request.headers.addAll({
        'Authorization': 'Bearer $token',
        'Accept': 'text/event-stream',
        'Cache-Control': 'no-cache',
      });
      final response = await _http.send(request);
      if (_disposed || _backgrounded) {
        unawaited(response.stream.drain<void>().catchError((_) {}));
        return;
      }
      if (_auth.sessionGeneration != _generationAtConnect) return;

      if (response.statusCode != 200) {
        await _handleConnectFailure(response.statusCode);
        return;
      }

      _attempt = 0;
      _setStatus(RealtimeConnectionStatus.connected);
      final parser = SseStreamParser();
      _subscription = response.stream
          .transform(utf8.decoder)
          .listen(
            (chunk) {
              for (final frame in parser.addChunk(chunk)) {
                _handleFrame(frame);
              }
            },
            onError: (_) => _onStreamEnded(),
            onDone: _onStreamEnded,
            cancelOnError: true,
          );
    } catch (_) {
      _onStreamEnded();
    }
  }

  Future<void> _handleConnectFailure(int statusCode) async {
    if (statusCode == 401 || statusCode == 403) {
      // Reuse the EXISTING refresh-or-fail path verbatim — `/auth/me` is a
      // real, already-used-elsewhere endpoint; `ApiClient._request` already
      // does single-flight refresh-on-401 and, on failure, calls
      // `onSessionExpired` and clears tokens itself. No second refresh
      // implementation is introduced here (Stage 5 §5.1).
      try {
        await _api.get('/auth/me');
      } catch (_) {
        // Refresh failed: `onSessionExpired` already ran inside `ApiClient`,
        // `AuthProvider.phase` is already transitioning to `unauthenticated`,
        // and this whole provider subtree will be disposed shortly. Do not
        // schedule a reconnect — an unrecoverable auth rejection must not
        // retry forever (Stage 5 §5.2).
        return;
      }
    }
    _onStreamEnded();
  }

  void _onStreamEnded() {
    _subscription = null;
    if (_disposed || _backgrounded) return;
    _scheduleReconnect();
  }

  void _scheduleReconnect() {
    if (_disposed || _backgrounded) return;
    _attempt += 1;
    _setStatus(RealtimeConnectionStatus.reconnecting);
    final backoffMs = min(
      _maxBackoff.inMilliseconds,
      _baseBackoff.inMilliseconds * pow(2, _attempt - 1).toInt(),
    );
    final jitterMs = (backoffMs * (0.5 + Random().nextDouble() * 0.5)).toInt();
    _reconnectTimer?.cancel();
    _reconnectTimer = Timer(Duration(milliseconds: jitterMs), () {
      unawaited(_connect());
    });
  }

  void _handleFrame(SseFrame frame) {
    if (_disposed || _backgrounded) return;
    if (_auth.sessionGeneration != _generationAtConnect) {
      // The identity bound to this connection has moved on (logout, a
      // different account logging in on the same device) — a stale stream
      // must never deliver into the new identity's state. Close it outright
      // rather than keep silently reading frames nobody should act on.
      unawaited(_subscription?.cancel());
      _subscription = null;
      return;
    }
    final envelope = parseRealtimeEnvelope(frame.data);
    if (envelope == null) return; // malformed, unknown version/type — dropped, never crashes the app
    if (!_rememberEventId(envelope.eventId)) return; // at-least-once duplicate, already handled
    _route(envelope);
  }

  /// Bounded FIFO containment — returns false (and does nothing) for an
  /// eventId already seen within the last [_dedupWindowSize] events.
  bool _rememberEventId(String eventId) {
    if (_seenEventIdSet.contains(eventId)) return false;
    _seenEventIdSet.add(eventId);
    _seenEventIds.add(eventId);
    if (_seenEventIds.length > _dedupWindowSize) {
      _seenEventIdSet.remove(_seenEventIds.removeFirst());
    }
    return true;
  }

  /// Every branch calls an EXISTING provider refresh method — never writes
  /// the envelope's own fields into application state. The authoritative
  /// API response, not the event payload, is always the source of truth.
  void _route(RealtimeEnvelope envelope) {
    switch (envelope.type) {
      case 'offer.sent':
      case 'offer.confirmed':
        // Staff-facing: Offers/Confirmed/Upcoming/Calendar all read this one
        // provider (see offers_provider.dart's own fan-out via notifyListeners).
        unawaited(_offers?.load(silent: true));
      case 'offer.accepted':
        // Manager-facing (`assignedBy`) — the only Flutter root that can ever
        // be the recipient is Venue Manager; an internal Manager/CEO account
        // uses the web console for this (see app.dart's `ConsoleEntryScreen`
        // deep-link for those two presentations), so there is nothing to
        // refresh here when `_venueManager` is null.
        unawaited(_venueManager?.refresh(silent: true));
    }
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
        break; // transient, not a real background transition — no existing observer in this app treats these as backgrounded either
    }
  }

  void _enterBackground() {
    if (_disposed || _backgrounded) return;
    _backgrounded = true;
    _reconnectTimer?.cancel();
    unawaited(_subscription?.cancel());
    _subscription = null;
    _setStatus(RealtimeConnectionStatus.offline);
  }

  void _leaveBackground() {
    if (_disposed || !_backgrounded) return;
    _backgrounded = false;
    _attempt = 0;
    unawaited(_connect());
    // Reconcile exactly like the app's own existing resume hooks already do
    // (app_shell.dart, schedule_clock_screen.dart, venue_manager_screens.dart)
    // — an SSE connection cannot be assumed to have delivered every event
    // that occurred while backgrounded, so the authoritative lists are
    // refetched directly, not merely "waited for the next push."
    unawaited(_offers?.load(silent: true));
    unawaited(_attendance?.refreshActive(silent: true));
    unawaited(_attendance?.loadHistory(silent: true));
    unawaited(_venueManager?.refresh(silent: true));
  }

  @override
  void dispose() {
    _disposed = true;
    WidgetsBinding.instance.removeObserver(this);
    _reconnectTimer?.cancel();
    unawaited(_subscription?.cancel());
    _http.close();
    super.dispose();
  }
}
