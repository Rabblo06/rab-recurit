import 'package:flutter/foundation.dart';

import '../../core/api/api_client.dart';
import '../../core/models/offer.dart';
import '../../core/polling/keyset_pages.dart';
import '../../core/polling/single_flight.dart';
import '../../core/theme/shift_visual_style.dart';

class OffersProvider extends ChangeNotifier {
  OffersProvider(this._api) {
    load(full: true);
  }

  final ApiClient _api;
  final Stopwatch _sinceSync = Stopwatch();
  DateTime? _serverNow;
  final SingleFlight _flight = SingleFlight();
  bool _disposed = false;
  // Merged flags of every caller waiting for the next load (see [load]).
  bool _pendingLoud = false;
  bool _pendingForeground = false;
  bool _pendingFull = false;
  DateTime? get trustedNow => _serverNow?.add(_sinceSync.elapsed);

  List<OfferSummary> offers = [];
  bool isLoading = true;
  bool isRefreshing = false;
  String? loadError;

  /// The error of the last load (null after a success), for pollers' backoff.
  Object? lastFailure;

  String? busyOfferId;
  String? busyAction; // 'accept' | 'decline'
  String? errorOfferId;
  String? errorMessage;

  /// Page sizes (API contract §1/§3). The current scope is bounded server-side
  /// (shifts not yet ended + offers sent in the last 30 days), so walking it is
  /// cheap enough for every poll.
  static const currentPageSize = 50;
  static const fullPageSize = 200;

  /// Loads `/offers/mine` with keyset paging.
  ///
  /// - [full] (first load of the session, pull-to-refresh): `scope=all`, every
  ///   page, replacing the list — the staff Calendar still shows confirmed
  ///   shifts of past months, so nothing older is dropped.
  /// - otherwise (poll, resume, after the user's own action): `scope=current`,
  ///   every page, merged by id into the list (older rows outside the current
  ///   window are kept as last read).
  ///
  /// At most one walk runs at a time. A call while one is in flight is QUEUED
  /// (one follow-up fetch after it, shared by every caller queued meanwhile),
  /// never dropped, so a reload after the user's own check-in/clock-in always
  /// reads state from after that action. [joinInFlight] (automatic refreshes
  /// only: timer, resume) shares the in-flight walk instead. [background]
  /// marks a timer-driven read (`X-Crewflow-Background`).
  Future<void> load({
    bool silent = false,
    bool background = false,
    bool full = false,
    bool joinInFlight = false,
  }) {
    if (joinInFlight && _flight.isRunning) return _flight.join(_runLoad);
    _pendingLoud |= !silent;
    _pendingForeground |= !background;
    _pendingFull |= full;
    return _flight.run(_runLoad);
  }

  Future<void> _runLoad() async {
    final silent = !_pendingLoud;
    final background = !_pendingForeground;
    final full = _pendingFull;
    _pendingLoud = false;
    _pendingForeground = false;
    _pendingFull = false;
    if (_disposed) return;
    if (!silent) isLoading = true;
    notifyListeners();
    try {
      final rows = await fetchAllKeysetPages(
        _api,
        '/offers/mine',
        query: full ? 'scope=all' : 'scope=current',
        limit: full ? fullPageSize : currentPageSize,
        background: background,
      );
      if (_disposed) return;
      final fresh = rows.map(OfferSummary.fromJson).toList();
      offers = full ? fresh : mergeOffers(offers, fresh);
      ShiftVisualStyle.registerGroup(offers.map((offer) => offer.shiftId));
      final serverNow = fresh
          .map((o) => o.presentation?.serverNow)
          .nonNulls
          .firstOrNull;
      // Re-anchor only on a fresh server time: rows kept from an earlier read
      // carry an older one, which would move trustedNow backwards.
      if (serverNow != null || full) {
        _serverNow = serverNow;
        _sinceSync
          ..reset()
          ..start();
      }
      loadError = null;
      lastFailure = null;
    } catch (e) {
      if (_disposed) return;
      lastFailure = e;
      loadError = 'Could not load offers. Please try again.';
    } finally {
      if (!_disposed) {
        isLoading = false;
        isRefreshing = false;
        notifyListeners();
      }
    }
  }

  /// Fresh rows replace the same ids; rows not in [fresh] are kept. Server
  /// order (`sent_at DESC, id DESC`).
  @visibleForTesting
  static List<OfferSummary> mergeOffers(
    List<OfferSummary> previous,
    List<OfferSummary> fresh,
  ) {
    final byId = {for (final o in previous) o.id: o};
    for (final o in fresh) {
      byId[o.id] = o;
    }
    return byId.values.toList()..sort((a, b) {
      final bySent = b.sentAt.compareTo(a.sentAt);
      return bySent != 0 ? bySent : b.id.compareTo(a.id);
    });
  }

  Future<void> refresh() async {
    isRefreshing = true;
    notifyListeners();
    await load(silent: true, full: true);
  }

  Future<void> respond(String offerId, String action) async {
    busyOfferId = offerId;
    busyAction = action;
    errorOfferId = null;
    errorMessage = null;
    notifyListeners();
    try {
      await _api.post('/offers/$offerId/$action');
      await load(silent: true);
    } on ApiException catch (e) {
      errorOfferId = offerId;
      errorMessage = e.userMessage;
    } catch (e) {
      errorOfferId = offerId;
      errorMessage = userMessageFor(e);
    } finally {
      busyOfferId = null;
      busyAction = null;
      if (!_disposed) notifyListeners();
    }
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
