import 'dart:async';
import 'dart:io' show HandshakeException, SocketException;

import 'package:flutter/foundation.dart';
import 'package:http/http.dart' as http;

import '../../core/api/api_client.dart';
import '../../core/polling/single_flight.dart';
import '../../core/push/push_device_store.dart';
import '../../core/services/location_service.dart';
import 'boot_clock.dart';
import 'entry_signer.dart';
import 'offline_config.dart';
import 'offline_entry.dart';
import 'offline_messages.dart';
import 'offline_queue_store.dart';
import 'offline_sync_client.dart';
import 'offline_ticket.dart';

/// True when a request failed BEFORE any response arrived (DESIGN §3.1): no connectivity, DNS, socket or TLS failure,
/// or a timeout (an uncertain outcome: the same idempotency key is reused, so the server either reports the first
/// attempt as applied or applies it once). Any HTTP response, a 5xx included, is NOT this: it is shown as an error.
bool isNoResponseFailure(Object error) =>
    error is SocketException ||
    error is HandshakeException ||
    error is http.ClientException ||
    error is TimeoutException ||
    (error is ApiException && error.statusCode == 408);

enum OfflineCaptureOutcome {
  queued,
  notEnabled,
  needsTicket,
  full,
  unreadable,
  notClockedIn,
  alreadySaved,
  failed,
}

class OfflineCaptureResult {
  const OfflineCaptureResult(this.outcome, {this.punch, this.message});
  final OfflineCaptureOutcome outcome;
  final QueuedPunch? punch;

  /// Staff text for a refused capture (null when queued).
  final String? message;
  bool get queued => outcome == OfflineCaptureOutcome.queued;
}

/// The offline queue for ONE signed-in staff member (created per session in `app.dart`, keyed by user id, disposed on
/// logout or account switch).
///
/// It only ever holds anything when every switch in `offline_config.dart` is on; today the device-key signer is a
/// placeholder that is never available, so [mayQueue] is always false on a real phone (owner HARD RULE).
class OfflineSyncController extends ChangeNotifier {
  OfflineSyncController({
    required this.userId,
    OfflineQueueStore? store,
    BootClock? bootClock,
    OfflineEntrySigner? signer,
    bool? buildFlag,
    DateTime Function()? deviceNow,
    OfflineSyncClient? client,
  }) : _client = client,
       _store = store ?? OfflineQueueStore(),
       _bootClock = bootClock ?? const PlatformBootClock(),
       _signer = signer ?? const UnavailableEntrySigner(),
       _buildFlag = buildFlag ?? kOfflineAttendanceBuildFlag,
       _deviceNow = deviceNow ?? DateTime.now {
    ready = _restore();
  }

  final String userId;
  final OfflineQueueStore _store;
  final BootClock _bootClock;
  final OfflineEntrySigner _signer;
  final bool _buildFlag;
  final DateTime Function() _deviceNow;

  /// Null: nothing is ever sent (tests of capture only).
  final OfflineSyncClient? _client;
  final SingleFlight _flight = SingleFlight();
  int _failures = 0;
  DateTime? _backoffUntil;
  DateTime? _retryAfterUntil;

  /// Called after a sync in which the server acknowledged at least one entry, so the attendance state is re-read
  /// from the server (the card switches to the server timer only then).
  VoidCallback? onApplied;

  /// One-off server notices for the staff member (the D3 "recorded as your shift start" line). Display only.
  final List<String> notices = [];

  bool get isSyncing => _flight.isRunning;

  /// Something for the banner to show.
  bool get hasSomethingToShow =>
      _entries.isNotEmpty || unreadable || notices.isNotEmpty;

  /// Completes once the stored queue and ticket have been read.
  late final Future<void> ready;
  bool _disposed = false;

  /// What the last `GET /attendance/me/active` said (`offline.enabled == true` exactly). Off until then.
  bool serverEnabled = false;
  StoredOfflineTicket? _ticket;
  List<QueuedPunch> _entries = const [];

  /// A stored queue exists but cannot be read (nothing in it can be sent; see [OfflineQueueSnapshot.unreadable]).
  bool unreadable = false;

  List<QueuedPunch> get entries => _entries;
  Iterable<QueuedPunch> get pending => _entries.where((e) => e.isPending);
  int get pendingCount => pending.length;

  /// D18: logout is blocked while this is true.
  bool get hasUnsent => pendingCount > 0;

  /// Entries the staff member should look at (refused, too old, could not send) or an unreadable queue.
  bool get needsAttention => unreadable || _entries.any((e) => !e.isPending);

  /// Whether a failed punch may be saved on this phone instead (synchronous pre-check; [capture] re-checks the boot
  /// clock and the ticket age).
  bool get mayQueue =>
      _buildFlag &&
      serverEnabled &&
      _ticket != null &&
      _signer.isAvailable &&
      _signer.deviceKeyId != null &&
      !unreadable;

  /// A fresh UUID v4 for one tap; the online attempt and its queued fallback share it (D17).
  String newIdempotencyKey() => PushDeviceStore.generateUuidV4();

  /// The latest pending entry of [type] for [shiftId], if any.
  QueuedPunch? pendingFor(String? shiftId, OfflinePunchType type) {
    if (shiftId == null) return null;
    return pending
        .where((e) => e.entry.shiftId == shiftId && e.entry.type == type)
        .lastOrNull;
  }

  /// The shift a pending clock-in is waiting for, when its clock-out has not been saved yet.
  String? get pendingClockInShiftId {
    for (final e in pending.toList().reversed) {
      if (e.entry.type == OfflinePunchType.clockIn &&
          pendingFor(e.entry.shiftId, OfflinePunchType.clockOut) == null) {
        return e.entry.shiftId;
      }
    }
    return null;
  }

  Future<void> _restore() async {
    try {
      final snapshot = await _store.load(userId);
      _entries = snapshot.entries;
      unreadable = snapshot.unreadable;
      _ticket = _buildFlag ? await _store.loadTicket(userId) : null;
      await markTooOld();
    } catch (_) {
      // Secure storage unavailable: nothing is queued (mayQueue needs a ticket), nothing is lost.
    }
    _notify();
  }

  void _notify() {
    if (!_disposed) notifyListeners();
  }

  /// Reads the offline settings and ticket from a successful `GET /attendance/me/active` (DESIGN §3.1, §4.2).
  /// [fetchDuration] is how long that request took: a ticket fetched in more than 10 s is thrown away (the previous
  /// one, if any, is kept). When the build flag or the server says off, any stored ticket is deleted.
  Future<void> ingestActive(
    Map<String, dynamic> data, {
    required Duration fetchDuration,
  }) async {
    // A build without the offline flag does nothing here at all: no platform call, no storage write.
    if (!_buildFlag) {
      serverEnabled = false;
      // Only entries a flag-on build left behind could exist; they are still sent (the server decides).
      if (_entries.any((e) => e.isPending)) unawaited(syncNow());
      return;
    }
    final reading = await _bootClock.read();
    await ready;
    final offline = data['offline'];
    serverEnabled = _buildFlag && offline is Map && offline['enabled'] == true;
    try {
      if (!serverEnabled) {
        if (_ticket != null) {
          _ticket = null;
          await _store.deleteTicket(userId);
        }
      } else {
        await _saveTicket(data['offlineTicket'], reading, fetchDuration);
      }
      await markTooOld();
    } catch (_) {
      // A storage failure leaves the in-memory state as it was; capture re-checks everything.
    }
    _notify();
    // DESIGN §3.5: a successful read (the 30 s reconcile, app resume, any read after a failure) triggers a sync.
    if (_entries.any((e) => e.isPending)) unawaited(syncNow());
  }

  /// Stores a fresh ticket (from `/me/active` or a sync response) with the boot reading taken when it arrived.
  /// Ignored unless offline is on, the token looks sane, the boot clock answered, and the fetch took <= 10 s.
  Future<void> _saveTicket(
    Object? token,
    BootReading? reading,
    Duration fetchDuration,
  ) async {
    if (!_buildFlag || !serverEnabled) return;
    if (token is! String || token.isEmpty || token.length > 4096) return;
    if (reading == null || fetchDuration > OfflineLimits.maxTicketFetch) {
      return;
    }
    final ticket = StoredOfflineTicket(
      token: token,
      bootId: reading.bootId,
      ticketBootMs: reading.elapsedMs,
      deviceWallClockAt: deviceWallClockIso(_deviceNow()),
    );
    await _store.saveTicket(userId, ticket);
    _ticket = ticket;
  }

  /// Saves a punch that could not reach the server. Refused (nothing stored) unless every switch is on, the ticket is
  /// from this boot and under 16 h old, the queue has room, and the device key signs it. The local dependency checks
  /// are UX only (§3.4); the server decides.
  ///
  /// [activeShiftId] is the server's open attendance (if any); [displayAt] is the server-anchored estimate at the tap
  /// (display only; never sent); [location] is the fix taken for this punch, if the venue needs one.
  Future<OfflineCaptureResult> capture({
    required OfflinePunchType type,
    required String shiftId,
    required String idempotencyKey,
    String? activeShiftId,
    String? qrToken,
    LocationFix? location,
    DateTime? displayAt,
  }) async {
    await ready;
    if (unreadable) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.unreadable,
        message: OfflineMessages.unreadable,
      );
    }
    if (!mayQueue) {
      return const OfflineCaptureResult(OfflineCaptureOutcome.notEnabled);
    }
    if (pending.any((e) => e.idempotencyKey == idempotencyKey) ||
        pendingFor(shiftId, type) != null) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.alreadySaved,
        message: OfflineMessages.alreadySaved,
      );
    }
    if (type == OfflinePunchType.clockOut &&
        activeShiftId != shiftId &&
        pendingFor(shiftId, OfflinePunchType.clockIn) == null) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.notClockedIn,
        message: OfflineMessages.notClockedIn,
      );
    }
    final reading = await _bootClock.read();
    final ticket = _ticket;
    if (ticket == null || reading == null || !ticket.canCaptureAt(reading)) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.needsTicket,
        message: OfflineMessages.needsTicket,
      );
    }
    try {
      final seq = await _store.nextClientSeq();
      final fixBootMs = location == null
          ? null
          : (reading.elapsedMs - location.age.inMilliseconds).clamp(
              0,
              reading.elapsedMs,
            );
      final unsigned = OfflineEntry(
        idempotencyKey: idempotencyKey,
        clientSeq: seq,
        type: type,
        shiftId: shiftId,
        ticket: ticket.token,
        bootId: ticket.bootId,
        ticketBootMs: ticket.ticketBootMs,
        punchBootId: reading.bootId,
        punchBootMs: reading.elapsedMs,
        deviceWallClockAt: deviceWallClockIso(_deviceNow()),
        ticketDeviceWallClockAt: ticket.deviceWallClockAt,
        qrToken: qrToken,
        location: location == null
            ? null
            : OfflineLocation(
                lat: location.lat,
                lng: location.lng,
                accuracyM: location.accuracyM,
                fixBootMs: fixBootMs!,
                mock: location.mock,
              ),
        appVersion: kOfflineAppVersion,
        deviceKeyId: _signer.deviceKeyId,
      );
      final sig = await _signer.sign(unsigned.signingPayload());
      if (sig == null || sig.isEmpty) {
        return const OfflineCaptureResult(
          OfflineCaptureOutcome.failed,
          message: OfflineMessages.captureFailed,
        );
      }
      final punch = QueuedPunch(
        entry: unsigned.withSignature(sig),
        displayAt: displayAt ?? _deviceNow(),
      );
      _entries = await _store.append(userId, punch);
      _notify();
      return OfflineCaptureResult(OfflineCaptureOutcome.queued, punch: punch);
    } on OfflineQueueFullException catch (e) {
      final unreadableQueue = e.reason == 'unreadable';
      return OfflineCaptureResult(
        unreadableQueue
            ? OfflineCaptureOutcome.unreadable
            : OfflineCaptureOutcome.full,
        message: unreadableQueue
            ? OfflineMessages.unreadable
            : OfflineMessages.queueFull,
      );
    } catch (_) {
      return const OfflineCaptureResult(
        OfflineCaptureOutcome.failed,
        message: OfflineMessages.captureFailed,
      );
    }
  }

  /// Marks pending entries older than 72 h (D5) as too old: they are never sent.
  Future<void> markTooOld() async {
    if (!_entries.any((e) => e.isPending)) return;
    final reading = await _bootClock.read();
    final now = _deviceNow();
    bool old(QueuedPunch e) =>
        e.isPending && e.entry.ageAt(reading, now) > OfflineLimits.maxSyncDelay;
    if (!_entries.any(old)) return;
    _entries = await _store.update(
      userId,
      (all) => [
        for (final e in all) old(e) ? e.withState(QueuedPunchState.tooOld) : e,
      ],
    );
  }

  /// Removes one refused / too-old / parked entry after the staff member has seen it. Pending entries cannot be
  /// dismissed one by one (only [discardAll], which the logout guard asks for explicitly).
  Future<void> dismiss(String idempotencyKey) async {
    _entries = await _store.update(
      userId,
      (all) => all
          .where((e) => e.isPending || e.idempotencyKey != idempotencyKey)
          .toList(),
    );
    _notify();
  }

  /// D18: the staff member explicitly discards everything saved on this phone. Discarded = never sent; the manager is
  /// not told. Also clears an unreadable queue and the ticket.
  Future<void> discardAll() async {
    await _store.clear(userId);
    _entries = const [];
    unreadable = false;
    _ticket = null;
    _notify();
  }

  /// Logout once nothing is waiting to send: deletes what is left (refused / too old results, the ticket), so nothing
  /// of this session stays at rest. Returns false (and deletes nothing) while punches are unsent.
  Future<bool> clearForLogout() async {
    await ready;
    if (hasUnsent) return false;
    await discardAll();
    return true;
  }

  /// Sends pending entries to `POST /attendance/me/sync` (DESIGN §3.5): `clientSeq` order, at most 25 per request,
  /// one request at a time (single-flight; a call during a run shares it).
  ///
  /// - 200: per item, `applied` / `duplicate` / `replayed` entries are deleted, `rejected` ones are kept (with their
  ///   code) until dismissed, and an entry the response does not mention stays pending.
  /// - 400 / 413 for a whole batch (a client bug): resent one at a time; an entry refused alone is parked
  ///   ("Could not send. Contact support") and never resent.
  /// - 401: the shared [ApiClient] already refreshed the token and retried once; a second 401 means the session
  ///   ended, so this stops (entries stay, keyed to this user).
  /// - 429: waits for `Retry-After` (60 s when absent), even for "Send now".
  /// - anything else (5xx, 403, 404, network, timeout, a malformed body): exponential backoff from 1 s to 5 min.
  ///   [userInitiated] ("Send now") skips this backoff, never the 429 wait.
  Future<void> syncNow({bool userInitiated = false}) =>
      _flight.join(() => _drain(userInitiated));

  Future<void> _drain(bool userInitiated) async {
    final client = _client;
    if (client == null) return;
    await ready;
    if (_disposed || unreadable) return;
    final now = _deviceNow();
    if (_retryAfterUntil != null && now.isBefore(_retryAfterUntil!)) return;
    if (!userInitiated &&
        _backoffUntil != null &&
        now.isBefore(_backoffUntil!)) {
      return;
    }
    try {
      await markTooOld();
    } catch (_) {
      return;
    }
    _notify(); // isSyncing
    var acknowledged = false;
    // An entry the server left unanswered is not resent in the same run.
    final tried = <String>{};
    try {
      while (!_disposed) {
        final batch = pending
            .where((e) => !tried.contains(e.idempotencyKey))
            .take(OfflineLimits.maxBatch)
            .toList();
        if (batch.isEmpty) break;
        tried.addAll(batch.map((e) => e.idempotencyKey));
        final progressed = await _send(
          client,
          batch,
          () => acknowledged = true,
        );
        if (!progressed) break;
      }
      _failures = 0;
      _backoffUntil = null;
    } on _StopSync {
      // The wait (backoff or Retry-After) is already set; entries stay as they are.
    }
    _notify();
    if (acknowledged && !_disposed) onApplied?.call();
  }

  /// Sends one batch. True when at least one entry left the pending state.
  Future<bool> _send(
    OfflineSyncClient client,
    List<QueuedPunch> batch,
    void Function() onAcknowledged,
  ) async {
    try {
      final fetch = Stopwatch()..start();
      final response = await client.postBatch([for (final p in batch) p.entry]);
      fetch.stop();
      final reading = await _bootClock.read();
      await _saveTicket(response.offlineTicket, reading, fetch.elapsed);
      return await _applyResults(batch, response, onAcknowledged);
    } on ApiException catch (e) {
      if (e.statusCode == 400 || e.statusCode == 413) {
        if (batch.length == 1) {
          await _setState(batch.single, QueuedPunchState.parked);
          return true;
        }
        var progressed = false;
        for (final punch in batch) {
          if (_disposed) break;
          if (await _send(client, [punch], onAcknowledged)) progressed = true;
        }
        return progressed;
      }
      if (e.statusCode == 429) {
        _retryAfterUntil = _deviceNow().add(
          e.retryAfter ?? const Duration(seconds: 60),
        );
        throw const _StopSync();
      }
      if (e.statusCode == 401) throw const _StopSync();
      _backOff();
      throw const _StopSync();
    } on _StopSync {
      rethrow;
    } catch (_) {
      // Network, timeout, malformed body, storage: keep everything, try later.
      _backOff();
      throw const _StopSync();
    }
  }

  void _backOff() {
    _failures++;
    final exponent = (_failures - 1).clamp(0, 16);
    final wait = OfflineLimits.minBackoff * (1 << exponent);
    _backoffUntil = _deviceNow().add(
      wait > OfflineLimits.maxBackoff ? OfflineLimits.maxBackoff : wait,
    );
  }

  /// The current wait before an automatic retry (tests and diagnostics).
  DateTime? get nextAutomaticAttemptAt => _backoffUntil;
  DateTime? get retryAfterUntil => _retryAfterUntil;

  Future<void> _setState(QueuedPunch punch, QueuedPunchState state) async {
    _entries = await _store.update(
      userId,
      (all) => [
        for (final e in all)
          e.idempotencyKey == punch.idempotencyKey ? e.withState(state) : e,
      ],
    );
  }

  Future<bool> _applyResults(
    List<QueuedPunch> batch,
    SyncBatchResponse response,
    void Function() onAcknowledged,
  ) async {
    final sent = {for (final p in batch) p.idempotencyKey};
    final byKey = {
      for (final r in response.results)
        if (sent.contains(r.idempotencyKey)) r.idempotencyKey: r,
    };
    var progressed = false;
    final newNotices = <String>[];
    _entries = await _store.update(userId, (all) {
      final next = <QueuedPunch>[];
      for (final e in all) {
        final result = e.isPending ? byKey[e.idempotencyKey] : null;
        if (result == null) {
          next.add(e);
        } else if (result.acknowledged) {
          progressed = true;
          onAcknowledged();
          final at = result.appliedAt;
          if (result.flags.contains('clamped_to_schedule') && at != null) {
            newNotices.add(OfflineMessages.clamped(e.entry.type, at));
          }
        } else if (result.rejected) {
          progressed = true;
          next.add(
            e.withState(
              QueuedPunchState.rejected,
              code: result.code,
              qrReason: result.reason,
            ),
          );
        } else {
          next.add(e); // an outcome this build does not know: keep it pending
        }
      }
      return next;
    });
    notices.addAll(newNotices);
    return progressed;
  }

  void dismissNotice(String notice) {
    notices.remove(notice);
    _notify();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}

/// Ends one sync run (the wait is already recorded).
class _StopSync implements Exception {
  const _StopSync();
}
