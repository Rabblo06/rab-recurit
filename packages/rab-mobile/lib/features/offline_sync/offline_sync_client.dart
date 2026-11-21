import '../../core/api/api_client.dart';
import 'offline_entry.dart';

/// One per-item outcome from `POST /rest/v1/attendance/me/sync` (DESIGN §7.2, §4.6).
class SyncItemResult {
  const SyncItemResult({
    required this.idempotencyKey,
    required this.outcome,
    this.code,
    this.reason,
    this.flags = const [],
    this.appliedAt,
  });

  final String idempotencyKey;

  /// `applied` | `duplicate` | `replayed` | `rejected` (anything else is treated as "no answer for this entry").
  final String outcome;

  /// The rejection code (§4.6), when rejected (or a replay of a stored rejection).
  final String? code;

  /// `INVALID_QR` detail.
  final String? reason;
  final List<String> flags;

  /// The server's recorded time (display only, e.g. the D3 "recorded as 09:00" notice).
  final DateTime? appliedAt;

  /// The server holds this entry: it can be deleted from the phone.
  bool get acknowledged =>
      (outcome == 'applied' ||
          outcome == 'duplicate' ||
          outcome == 'replayed') &&
      code == null;

  /// The server refused this entry (a replay of a stored refusal counts too).
  bool get rejected =>
      outcome == 'rejected' || (outcome == 'replayed' && code != null);

  static SyncItemResult? tryParse(Object? json) {
    if (json is! Map) return null;
    final key = json['idempotencyKey'];
    final outcome = json['outcome'];
    if (key is! String || outcome is! String) return null;
    final code = json['code'];
    final reason = json['reason'];
    final flags = json['flags'];
    final appliedAt = json['appliedAt'];
    return SyncItemResult(
      idempotencyKey: key,
      outcome: outcome,
      code: code is String && RegExp(r'^[A-Z][A-Z_]{2,48}$').hasMatch(code)
          ? code
          : (outcome == 'rejected' ? 'UNKNOWN' : null),
      reason: reason is String ? reason : null,
      flags: flags is List ? flags.whereType<String>().toList() : const [],
      appliedAt: appliedAt is String ? DateTime.tryParse(appliedAt) : null,
    );
  }
}

/// The 200 body of `POST /attendance/me/sync`.
class SyncBatchResponse {
  const SyncBatchResponse({
    required this.results,
    this.serverNow,
    this.offlineTicket,
  });

  final List<SyncItemResult> results;
  final DateTime? serverNow;
  final String? offlineTicket;

  /// A body without a `results` list is malformed (FormatException): nothing is deleted on a guess.
  factory SyncBatchResponse.parse(Object? json) {
    if (json is! Map || json['results'] is! List) {
      throw const FormatException('Malformed sync response');
    }
    final ticket = json['offlineTicket'];
    final serverNow = json['serverNow'];
    return SyncBatchResponse(
      results: [
        for (final item in json['results'] as List)
          ?SyncItemResult.tryParse(item),
      ],
      serverNow: serverNow is String ? DateTime.tryParse(serverNow) : null,
      offlineTicket: ticket is String && ticket.isNotEmpty ? ticket : null,
    );
  }
}

/// Transport for the sync contract (DESIGN §7). One request per call; the controller decides batching, order, retry
/// and backoff. Errors propagate unchanged ([ApiException] for an HTTP error; socket/TLS/timeout errors as thrown by
/// [ApiClient]). The shared [ApiClient] refreshes an expired access token once on a 401 and never replays a request
/// across a logout.
class OfflineSyncClient {
  const OfflineSyncClient(this._api);
  final ApiClient _api;

  static const path = '/attendance/me/sync';

  /// The user the signed-in session belongs to (what the API client stores at login). The controller sends a queue only
  /// when this equals the queue's user.
  Future<String?> sessionUserId() => _api.getSessionUserId();

  Future<SyncBatchResponse> postBatch(List<OfflineEntry> entries) async {
    final data = await _api.post(
      path,
      body: {
        'entries': [for (final e in entries) e.toWireJson()],
      },
    );
    return SyncBatchResponse.parse(data);
  }
}
