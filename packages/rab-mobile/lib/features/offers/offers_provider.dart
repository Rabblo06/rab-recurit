import 'package:flutter/foundation.dart';

import '../../core/api/api_client.dart';
import '../../core/models/offer.dart';
import '../../core/theme/shift_visual_style.dart';

class OffersProvider extends ChangeNotifier {
  OffersProvider(this._api) {
    load();
  }

  final ApiClient _api;
  final Stopwatch _sinceSync = Stopwatch();
  DateTime? _serverNow;
  bool _loading = false;
  DateTime? get trustedNow => _serverNow?.add(_sinceSync.elapsed);

  List<OfferSummary> offers = [];
  bool isLoading = true;
  bool isRefreshing = false;
  String? loadError;

  String? busyOfferId;
  String? busyAction; // 'accept' | 'decline'
  String? errorOfferId;
  String? errorMessage;

  Future<void> load({bool silent = false}) async {
    if (_loading) return;
    _loading = true;
    if (!silent) isLoading = true;
    notifyListeners();
    try {
      final data = await _api.get('/offers/mine') as List<dynamic>;
      offers = data
          .map((e) => OfferSummary.fromJson(e as Map<String, dynamic>))
          .toList();
      ShiftVisualStyle.registerGroup(offers.map((offer) => offer.shiftId));
      _serverNow = offers
          .map((o) => o.presentation?.serverNow)
          .nonNulls
          .firstOrNull;
      _sinceSync
        ..reset()
        ..start();
      loadError = null;
    } catch (_) {
      loadError = 'Could not load offers. Please try again.';
    } finally {
      _loading = false;
      isLoading = false;
      isRefreshing = false;
      notifyListeners();
    }
  }

  Future<void> refresh() async {
    isRefreshing = true;
    notifyListeners();
    await load(silent: true);
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
      errorMessage = e.message;
    } catch (_) {
      errorOfferId = offerId;
      errorMessage = 'Something went wrong. Try again.';
    } finally {
      busyOfferId = null;
      busyAction = null;
      notifyListeners();
    }
  }
}
