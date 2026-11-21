import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'package:rab_staff/core/api/api_client.dart';
import 'package:rab_staff/features/offline_sync/offline_config.dart';
import 'package:rab_staff/features/offline_sync/offline_entry.dart';
import 'package:rab_staff/features/offline_sync/offline_queue_store.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_client.dart';
import 'package:rab_staff/features/offline_sync/offline_sync_controller.dart';

import 'support/biometric_test_support.dart';
import 'support/offline_test_support.dart';

/// M4 offline queue, PR 3: the sync client against a MOCKED `POST /rest/v1/attendance/me/sync` (DESIGN §3.5, §7.2).
/// The real endpoint does not exist yet and offline mode is OFF everywhere (owner HARD RULE).
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Map<String, String> secure;
  late DateTime now;
  late FakeBootClock boot;

  setUp(() {
    secure = {
      'rab.accessToken': 'access-1',
      'rab.refreshToken': 'refresh-1',
      'rab.sessionUserId': 'user-a',
    };
    stubSecureStorageChannel(secure);
    now = DateTime.utc(2026, 11, 21, 10);
    boot = FakeBootClock(elapsedMs: 1100000 + 60000);
  });
  tearDown(clearSecureStorageChannel);

  /// Seeds [n] pending clock-ins for [userId] (clientSeq 1..n).
  Future<void> seed(int n, {String userId = 'user-a'}) async {
    final store = OfflineQueueStore();
    for (var i = 1; i <= n; i++) {
      await store.append(
        userId,
        samplePunch(key: keyFor(i), seq: i, shiftId: 'shift-$i'),
      );
    }
  }

  /// The mocked server. [handle] gets the decoded entries of each sync request.
  ({
    ApiClient api,
    List<List<Map<String, dynamic>>> batches,
    List<http.Request> requests,
  })
  server(
    Future<http.Response> Function(List<Map<String, dynamic>> entries, int call)
    handle,
  ) {
    final batches = <List<Map<String, dynamic>>>[];
    final requests = <http.Request>[];
    final api = ApiClient(
      httpClient: MockClient((request) async {
        if (!request.url.path.endsWith(OfflineSyncClient.path)) {
          return http.Response('not found', 404);
        }
        requests.add(request);
        final entries = ((jsonDecode(request.body) as Map)['entries'] as List)
            .cast<Map<String, dynamic>>();
        batches.add(entries);
        return handle(entries, batches.length);
      }),
    );
    return (api: api, batches: batches, requests: requests);
  }

  http.Response ok(List<Map<String, Object?>> results, {String? ticket}) =>
      http.Response(
        jsonEncode({
          'serverNow': '2026-11-21T10:00:00.000Z',
          'results': results,
          'offlineTicket': ?ticket,
        }),
        200,
      );

  Map<String, Object?> applied(Map<String, dynamic> e) => {
    'idempotencyKey': e['idempotencyKey'],
    'outcome': 'applied',
    'type': e['type'],
    'appliedAt': '2026-11-21T09:00:00.000Z',
    'timeTrust': 'anchored',
    'flags': <String>[],
  };

  Future<OfflineSyncController> controller(
    ApiClient api, {
    String userId = 'user-a',
  }) async {
    final c = OfflineSyncController(
      userId: userId,
      bootClock: boot,
      signer: FakeEntrySigner(),
      buildFlag: true,
      deviceNow: () => now,
      client: OfflineSyncClient(api),
    );
    await c.ready;
    return c;
  }

  test(
    'sends pending entries in clientSeq order, at most 25 per request, and deletes applied ones',
    () async {
      await seed(30);
      final s = server(
        (entries, _) async => ok([for (final e in entries) applied(e)]),
      );
      final c = await controller(s.api);
      var appliedCalls = 0;
      c.onApplied = () => appliedCalls++;
      await c.syncNow();
      expect(s.batches.map((b) => b.length), [OfflineLimits.maxBatch, 5]);
      final seqs = [
        for (final b in s.batches)
          for (final e in b) e['clientSeq'] as int,
      ];
      expect(seqs, List.generate(30, (i) => i + 1));
      for (final e in s.batches.expand((b) => b)) {
        expect(e.keys.toSet().intersection(kForbiddenEntryFields), isEmpty);
        expect(e['sig'], isNotNull);
      }
      expect(c.entries, isEmpty);
      expect(secure.containsKey(OfflineQueueStore.queueKey('user-a')), isFalse);
      expect(appliedCalls, 1);
    },
  );

  test(
    'partial success: applied / duplicate / replayed deleted; rejected kept with its code; unanswered stays pending',
    () async {
      await seed(5);
      final s = server(
        (entries, _) async => ok([
          applied(entries[0]),
          {
            'idempotencyKey': entries[1]['idempotencyKey'],
            'outcome': 'duplicate',
          },
          {
            'idempotencyKey': entries[2]['idempotencyKey'],
            'outcome': 'replayed',
          },
          {
            'idempotencyKey': entries[3]['idempotencyKey'],
            'outcome': 'rejected',
            'code': 'INVALID_QR',
            'reason': 'revoked',
          },
          // entries[4]: no result at all.
          {'idempotencyKey': 'not-in-this-batch', 'outcome': 'applied'},
        ]),
      );
      final c = await controller(s.api);
      await c.syncNow();
      expect(
        s.batches,
        hasLength(1),
        reason: 'an unanswered entry does not loop',
      );
      expect(c.entries.map((e) => e.idempotencyKey), [keyFor(4), keyFor(5)]);
      final rejected = c.entries.first;
      expect(rejected.state, QueuedPunchState.rejected);
      expect(rejected.code, 'INVALID_QR');
      expect(rejected.qrReason, 'revoked');
      expect(c.entries.last.state, QueuedPunchState.pending);
      expect(c.hasUnsent, isTrue);
      expect(c.needsAttention, isTrue);
    },
  );

  test('a replay of a stored refusal is a refusal, not a deletion', () async {
    await seed(1);
    final s = server(
      (entries, _) async => ok([
        {
          'idempotencyKey': entries[0]['idempotencyKey'],
          'outcome': 'replayed',
          'code': 'REPORT_FINALISED',
        },
      ]),
    );
    final c = await controller(s.api);
    await c.syncNow();
    expect(c.entries.single.state, QueuedPunchState.rejected);
    expect(c.entries.single.code, 'REPORT_FINALISED');
  });

  test(
    'a 400 for the batch resends one at a time and parks only the offending entry',
    () async {
      await seed(3);
      final s = server((entries, _) async {
        if (entries.any((e) => e['idempotencyKey'] == keyFor(2))) {
          return http.Response(
            '{"message":["property x should not exist"]}',
            400,
          );
        }
        return ok([for (final e in entries) applied(e)]);
      });
      final c = await controller(s.api);
      await c.syncNow();
      expect(s.batches.map((b) => b.length), [3, 1, 1, 1]);
      expect(c.entries.single.idempotencyKey, keyFor(2));
      expect(c.entries.single.state, QueuedPunchState.parked);
      // A parked entry is never resent.
      await c.syncNow(userInitiated: true);
      expect(s.batches, hasLength(4));
    },
  );

  test('429 waits for Retry-After, even for "Send now"', () async {
    await seed(1);
    var limited = true;
    final s = server((entries, _) async {
      if (limited) {
        return http.Response(
          '"ThrottlerException"',
          429,
          headers: {'retry-after': '30'},
        );
      }
      return ok([for (final e in entries) applied(e)]);
    });
    final c = await controller(s.api);
    await c.syncNow();
    expect(c.retryAfterUntil, now.add(const Duration(seconds: 30)));
    limited = false;
    await c.syncNow(userInitiated: true);
    expect(s.batches, hasLength(1));
    now = now.add(const Duration(seconds: 31));
    await c.syncNow();
    expect(s.batches, hasLength(2));
    expect(c.entries, isEmpty);
  });

  test(
    '5xx / network failures back off exponentially (1 s, 2 s, ... capped at 5 min); "Send now" skips the backoff',
    () async {
      await seed(1);
      var mode = 'down';
      final s = server((entries, _) async {
        if (mode == 'down') {
          throw http.ClientException('Network is unreachable');
        }
        if (mode == '503') return http.Response('{"message":"x"}', 503);
        return ok([for (final e in entries) applied(e)]);
      });
      final c = await controller(s.api);
      await c.syncNow();
      expect(c.nextAutomaticAttemptAt, now.add(const Duration(seconds: 1)));
      await c.syncNow();
      expect(s.batches, hasLength(1), reason: 'automatic retry waits');
      now = now.add(const Duration(seconds: 1));
      mode = '503';
      await c.syncNow();
      expect(c.nextAutomaticAttemptAt, now.add(const Duration(seconds: 2)));
      for (var i = 0; i < 12; i++) {
        await c.syncNow(userInitiated: true);
      }
      expect(
        c.nextAutomaticAttemptAt,
        now.add(OfflineLimits.maxBackoff),
        reason: 'capped at 5 min',
      );
      expect(c.entries.single.isPending, isTrue, reason: 'nothing lost');
      mode = 'ok';
      await c.syncNow(userInitiated: true);
      expect(c.entries, isEmpty);
      expect(
        c.nextAutomaticAttemptAt,
        isNull,
        reason: 'success resets the backoff',
      );
    },
  );

  test('a malformed 200 body deletes nothing', () async {
    await seed(2);
    final s = server((entries, _) async => http.Response('{"ok":true}', 200));
    final c = await controller(s.api);
    await c.syncNow();
    expect(c.entries, hasLength(2));
    expect(c.entries.every((e) => e.isPending), isTrue);
    expect(c.nextAutomaticAttemptAt, isNotNull);
  });

  test(
    '401: the shared client refreshes the token once and the batch is retried',
    () async {
      await seed(1);
      var calls = 0;
      final api = ApiClient(
        httpClient: MockClient((request) async {
          if (request.url.path.endsWith('/auth/refresh')) {
            return http.Response(
              jsonEncode({
                'accessToken': 'access-2',
                'refreshToken': 'refresh-2',
              }),
              200,
            );
          }
          calls++;
          if (request.headers['Authorization'] != 'Bearer access-2') {
            return http.Response('{"message":"Unauthorized"}', 401);
          }
          final entries = ((jsonDecode(request.body) as Map)['entries'] as List)
              .cast<Map<String, dynamic>>();
          return ok([for (final e in entries) applied(e)]);
        }),
      );
      final c = await controller(api);
      await c.syncNow();
      expect(calls, 2);
      expect(c.entries, isEmpty);
    },
  );

  test('401 with a dead session: stops and keeps every entry', () async {
    await seed(1);
    final api = ApiClient(
      httpClient: MockClient((request) async {
        if (request.url.path.endsWith('/auth/refresh')) {
          return http.Response('{"message":"Unauthorized"}', 401);
        }
        return http.Response('{"message":"Unauthorized"}', 401);
      }),
    );
    final c = await controller(api);
    await c.syncNow();
    expect(c.entries.single.isPending, isTrue);
  });

  test(
    'a fresh ticket in the response is stored with the boot reading at receipt',
    () async {
      await seed(1);
      final s = server(
        (entries, _) async =>
            ok([for (final e in entries) applied(e)], ticket: 'fresh-ticket'),
      );
      final c = await controller(s.api);
      await c.ingestActive({
        'offline': {'enabled': true},
        'offlineTicket': 'old-ticket',
      }, fetchDuration: Duration.zero);
      await c.syncNow(userInitiated: true);
      final stored = jsonDecode(secure[OfflineQueueStore.ticketKey('user-a')]!);
      expect(stored['token'], 'fresh-ticket');
      expect(stored['ticketBootMs'], boot.elapsedMs);
    },
  );

  test('entries older than 72 h are never sent', () async {
    await seed(1);
    boot.advance(OfflineLimits.maxSyncDelay + const Duration(hours: 1));
    final s = server((entries, _) async => ok([]));
    final c = await controller(s.api);
    await c.syncNow(userInitiated: true);
    expect(s.batches, isEmpty);
    expect(c.entries.single.state, QueuedPunchState.tooOld);
  });

  test('a time clamped to the schedule is explained once (D3)', () async {
    await seed(1);
    final s = server(
      (entries, _) async => ok([
        {
          ...applied(entries[0]),
          'flags': ['clamped_to_schedule'],
        },
      ]),
    );
    final c = await controller(s.api);
    await c.syncNow();
    expect(c.notices.single, contains('your shift start'));
    expect(c.hasSomethingToShow, isTrue);
    c.dismissNotice(c.notices.single);
    expect(c.hasSomethingToShow, isFalse);
  });

  test('another user\'s queue on the same phone is never sent', () async {
    await seed(3, userId: 'user-a');
    final s = server(
      (entries, _) async => ok([for (final e in entries) applied(e)]),
    );
    final b = await controller(s.api, userId: 'user-b');
    await b.syncNow(userInitiated: true);
    expect(s.batches, isEmpty);
    expect((await OfflineQueueStore().load('user-a')).entries, hasLength(3));
  });

  test('single-flight: concurrent syncs share one request', () async {
    await seed(2);
    final s = server(
      (entries, _) async => ok([for (final e in entries) applied(e)]),
    );
    final c = await controller(s.api);
    await Future.wait([
      c.syncNow(),
      c.syncNow(),
      c.syncNow(userInitiated: true),
    ]);
    expect(s.batches, hasLength(1));
  });

  test(
    'a successful /me/active read triggers a sync of what is waiting',
    () async {
      await seed(1);
      final s = server(
        (entries, _) async => ok([for (final e in entries) applied(e)]),
      );
      final c = await controller(s.api);
      await c.ingestActive({
        'offline': {'enabled': true},
        'offlineTicket': 't',
      }, fetchDuration: Duration.zero);
      await c.syncNow(); // joins the run ingestActive started
      expect(s.batches, hasLength(1));
      expect(c.entries, isEmpty);
    },
  );

  test(
    'response parsing: unknown outcomes and malformed items are ignored, a bad code is not trusted',
    () {
      final r = SyncBatchResponse.parse({
        'results': [
          {'idempotencyKey': 'a', 'outcome': 'teleported'},
          'garbage',
          {'idempotencyKey': 'b', 'outcome': 'rejected', 'code': 'drop table;'},
        ],
      });
      expect(r.results, hasLength(2));
      expect(r.results.first.acknowledged, isFalse);
      expect(r.results.first.rejected, isFalse);
      expect(r.results.last.rejected, isTrue);
      expect(r.results.last.code, 'UNKNOWN');
      expect(() => SyncBatchResponse.parse([]), throwsFormatException);
    },
  );

  test(
    'security review L5: the run stops at the first unanswered entry; nothing after it overtakes it',
    () async {
      await seed(30);
      final s = server(
        (entries, _) async => ok([
          for (final e in entries)
            if (e['clientSeq'] != 3) applied(e),
        ]),
      );
      final c = await controller(s.api);
      await c.syncNow();
      expect(s.batches, hasLength(1), reason: 'entries 26-30 were not sent');
      expect(c.entries.first.idempotencyKey, keyFor(3));
      expect(c.entries.first.isPending, isTrue);
      expect(c.entries.map((e) => e.entry.clientSeq), [3, 26, 27, 28, 29, 30]);
    },
  );

  test(
    'security review L5: a 400 bisect stops at the first entry left unanswered',
    () async {
      await seed(3);
      final s = server((entries, _) async {
        if (entries.length > 1) return http.Response('{"message":"bad"}', 400);
        if (entries.single['clientSeq'] == 1) return ok([]);
        return ok([for (final e in entries) applied(e)]);
      });
      final c = await controller(s.api);
      await c.syncNow();
      expect(s.batches.map((b) => b.length), [3, 1]);
      expect(c.pendingCount, 3);
    },
  );

  test(
    'security review L6: never sends while the session belongs to another user (account-switch window)',
    () async {
      await seed(2);
      secure['rab.sessionUserId'] = 'user-z';
      final s = server(
        (entries, _) async => ok([for (final e in entries) applied(e)]),
      );
      final c = await controller(s.api);
      await c.syncNow(userInitiated: true);
      expect(s.batches, isEmpty);
      secure.remove('rab.sessionUserId');
      await c.syncNow(userInitiated: true);
      expect(s.batches, isEmpty, reason: 'no session user: fail closed');
      secure['rab.sessionUserId'] = 'user-a';
      await c.syncNow(userInitiated: true);
      expect(s.batches, hasLength(1));
    },
  );

  test(
    'security review L6: a build without the offline flag never sends, even leftovers',
    () async {
      await seed(2);
      final s = server(
        (entries, _) async => ok([for (final e in entries) applied(e)]),
      );
      final c = OfflineSyncController(
        userId: 'user-a',
        bootClock: boot,
        signer: FakeEntrySigner(),
        buildFlag: false,
        deviceNow: () => now,
        client: OfflineSyncClient(s.api),
      );
      await c.ready;
      await c.ingestActive({
        'offline': {'enabled': true},
      }, fetchDuration: Duration.zero);
      await c.syncNow(userInitiated: true);
      expect(s.batches, isEmpty);
      expect(
        c.hasUnsent,
        isTrue,
        reason: 'still visible; the logout guard offers discard',
      );
    },
  );

  test('security review L6: Retry-After is capped at 15 min', () async {
    await seed(1);
    final s = server(
      (entries, _) async =>
          http.Response('"slow down"', 429, headers: {'retry-after': '86400'}),
    );
    final c = await controller(s.api);
    await c.syncNow();
    expect(c.retryAfterUntil, now.add(OfflineLimits.maxRetryAfter));
  });
}
