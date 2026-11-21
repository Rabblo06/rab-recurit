import 'dart:async';
import 'dart:convert';

import 'package:flutter_secure_storage/flutter_secure_storage.dart';

import '../../core/push/push_device_store.dart';
import '../../core/storage/secure_storage.dart';
import 'offline_config.dart';
import 'offline_entry.dart';
import 'offline_ticket.dart';

/// What [OfflineQueueStore.load] found. [unreadable] means a stored queue exists but could not be parsed: nothing in
/// it can be sent, nothing new is captured until the staff member dismisses it, and it is never silently dropped.
class OfflineQueueSnapshot {
  const OfflineQueueSnapshot(this.entries, {this.unreadable = false});
  final List<QueuedPunch> entries;
  final bool unreadable;
}

/// A capture refused by the DESIGN §3.4 limits (30 entries / 48 KB per user), or because an unreadable queue is
/// waiting to be dismissed.
class OfflineQueueFullException implements Exception {
  const OfflineQueueFullException(this.reason);
  final String reason;
  @override
  String toString() => 'OfflineQueueFullException: $reason';
}

/// The offline punch queue, encrypted at rest (DESIGN §3.3).
///
/// One JSON value per user in [appSecureStorage] (the app's one centrally configured secure storage: Android AES-GCM
/// data key wrapped by an Android Keystore RSA key; iOS Keychain `AfterFirstUnlockThisDeviceOnly`, not synchronizable),
/// key `rab.offline.queue.<userId>`. Device-only and out of backups (`android:allowBackup="false"`), wiped with the
/// rest of secure storage on a reinstall (`SecureStorageBootstrap`). No new dependency: no database or file store.
///
/// - Keyed by user: a different user signing in on the same phone never sees, sends or overwrites the previous
///   user's queue.
/// - The per-install sequence counter (`rab.offline.seq.<installId>`) is written BEFORE the number is used, so a
///   number is never reused, even after a crash.
/// - Every read-modify-write runs under one lock, so a capture and a sync result can never interleave and lose an
///   entry.
class OfflineQueueStore {
  OfflineQueueStore({FlutterSecureStorage? storage})
    : _storage = storage ?? appSecureStorage;

  final FlutterSecureStorage _storage;
  Future<void> _tail = Future<void>.value();

  static const int _docVersion = 1;
  static const String installIdKey = 'rab.offline.installId';
  static String queueKey(String userId) => 'rab.offline.queue.$userId';
  static String ticketKey(String userId) => 'rab.offline.ticket.$userId';
  static String seqKey(String installId) => 'rab.offline.seq.$installId';

  Future<T> _locked<T>(Future<T> Function() action) {
    final result = _tail.then((_) => action());
    _tail = result.then<void>((_) {}, onError: (Object _) {});
    return result;
  }

  Future<OfflineQueueSnapshot> load(String userId) =>
      _locked(() => _load(userId));

  Future<OfflineQueueSnapshot> _load(String userId) async {
    final raw = await _storage.read(key: queueKey(userId));
    if (raw == null) return const OfflineQueueSnapshot([]);
    try {
      final doc = jsonDecode(raw);
      if (doc is! Map || doc['v'] != _docVersion || doc['entries'] is! List) {
        return const OfflineQueueSnapshot([], unreadable: true);
      }
      final entries = [
        for (final item in doc['entries'] as List)
          QueuedPunch.fromStoreJson((item as Map).cast<String, Object?>()),
      ]..sort((a, b) => a.entry.clientSeq.compareTo(b.entry.clientSeq));
      return OfflineQueueSnapshot(entries);
    } catch (_) {
      return const OfflineQueueSnapshot([], unreadable: true);
    }
  }

  /// The encoded document, refused when it breaks a §3.4 limit.
  static String encode(List<QueuedPunch> entries) {
    if (entries.length > OfflineLimits.maxEntries) {
      throw const OfflineQueueFullException('too_many_entries');
    }
    final sorted = [...entries]
      ..sort((a, b) => a.entry.clientSeq.compareTo(b.entry.clientSeq));
    final encoded = jsonEncode({
      'v': _docVersion,
      'entries': [for (final e in sorted) e.toStoreJson()],
    });
    if (utf8.encode(encoded).length > OfflineLimits.maxBytes) {
      throw const OfflineQueueFullException('too_large');
    }
    return encoded;
  }

  Future<void> _save(String userId, List<QueuedPunch> entries) async {
    if (entries.isEmpty) {
      await _storage.delete(key: queueKey(userId));
      return;
    }
    await _storage.write(key: queueKey(userId), value: encode(entries));
  }

  /// Adds one captured punch. Refused (nothing written) when the queue is full, too large, unreadable, or already
  /// holds an entry with the same idempotency key or sequence number.
  Future<List<QueuedPunch>> append(String userId, QueuedPunch punch) =>
      _locked(() async {
        final snapshot = await _load(userId);
        if (snapshot.unreadable) {
          throw const OfflineQueueFullException('unreadable');
        }
        final existing = snapshot.entries;
        if (existing.any(
          (e) =>
              e.idempotencyKey == punch.idempotencyKey ||
              e.entry.clientSeq == punch.entry.clientSeq,
        )) {
          throw StateError('duplicate idempotency key or sequence number');
        }
        final next = [...existing, punch];
        await _save(userId, next); // encode() enforces the limits
        return List.unmodifiable(
          next..sort((a, b) => a.entry.clientSeq.compareTo(b.entry.clientSeq)),
        );
      });

  /// Applies [change] to the current entries and stores the result (sync outcomes, dismissals, marking too-old
  /// entries). Never used to add entries: only [append] checks a new capture.
  Future<List<QueuedPunch>> update(
    String userId,
    List<QueuedPunch> Function(List<QueuedPunch> current) change,
  ) => _locked(() async {
    final snapshot = await _load(userId);
    if (snapshot.unreadable) return const [];
    final next = change(List.of(snapshot.entries));
    final keys = {for (final e in snapshot.entries) e.idempotencyKey};
    if (next.any((e) => !keys.contains(e.idempotencyKey))) {
      throw StateError('update() may not add entries');
    }
    await _save(userId, next);
    return List.unmodifiable(
      next..sort((a, b) => a.entry.clientSeq.compareTo(b.entry.clientSeq)),
    );
  });

  /// Deletes this user's queue and ticket (explicit discard, or logout once nothing is waiting to send).
  Future<void> clear(String userId) => _locked(() async {
    await _storage.delete(key: queueKey(userId));
    await _storage.delete(key: ticketKey(userId));
  });

  /// The per-install id the sequence counter is keyed by (non-secret, a UUID v4). A reinstall gets a new one.
  Future<String> installId() => _locked(_installId);

  Future<String> _installId() async {
    final existing = await _storage.read(key: installIdKey);
    if (existing != null && PushDeviceStore.isUuid(existing)) return existing;
    final generated = PushDeviceStore.generateUuidV4();
    await _storage.write(key: installIdKey, value: generated);
    return generated;
  }

  /// The next `clientSeq`: strictly increasing per install, persisted before it is returned, so it is never reused.
  /// An unreadable counter fails closed (throws) instead of restarting from zero.
  Future<int> nextClientSeq() => _locked(() async {
    final key = seqKey(await _installId());
    final raw = await _storage.read(key: key);
    final current = raw == null ? 0 : int.parse(raw);
    if (current < 0) throw StateError('corrupt sequence counter');
    final next = current + 1;
    await _storage.write(key: key, value: '$next');
    return next;
  });

  Future<StoredOfflineTicket?> loadTicket(String userId) => _locked(() async {
    final raw = await _storage.read(key: ticketKey(userId));
    if (raw == null) return null;
    try {
      return StoredOfflineTicket.tryFromJson(jsonDecode(raw));
    } catch (_) {
      return null;
    }
  });

  Future<void> saveTicket(String userId, StoredOfflineTicket ticket) => _locked(
    () => _storage.write(
      key: ticketKey(userId),
      value: jsonEncode(ticket.toJson()),
    ),
  );

  Future<void> deleteTicket(String userId) =>
      _locked(() => _storage.delete(key: ticketKey(userId)));
}
