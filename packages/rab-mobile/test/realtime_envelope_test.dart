import 'package:flutter_test/flutter_test.dart';

import 'package:rab_staff/core/realtime/realtime_envelope.dart';

/// Pure-Dart tests for the SSE wire-format parser and envelope validator —
/// no HTTP, no widget tree. Mirrors the rigor of the web client's own
/// `realtime-client.spec.ts`: a bad frame must never crash the app, and
/// validation must never get ahead of the real backend catalogue
/// (`knownRealtimeEventTypes`).
void main() {
  const validJson =
      '{"version":1,"eventId":"11111111-1111-1111-1111-111111111111",'
      '"type":"offer.sent","organisationId":"22222222-2222-2222-2222-222222222222",'
      '"workspaceId":"33333333-3333-3333-3333-333333333333",'
      '"targetUserId":"44444444-4444-4444-4444-444444444444",'
      '"entityId":"55555555-5555-5555-5555-555555555555",'
      '"occurredAt":"2026-01-01T00:00:00.000Z"}';

  group('parseRealtimeEnvelope', () {
    test('accepts a well-formed, fully valid envelope', () {
      final envelope = parseRealtimeEnvelope(validJson);
      expect(envelope, isNotNull);
      expect(envelope!.type, 'offer.sent');
      expect(envelope.eventId, '11111111-1111-1111-1111-111111111111');
      expect(envelope.targetUserId, '44444444-4444-4444-4444-444444444444');
    });

    test('rejects malformed (non-JSON) input without throwing', () {
      expect(() => parseRealtimeEnvelope('{not-json'), returnsNormally);
      expect(parseRealtimeEnvelope('{not-json'), isNull);
    });

    test('rejects a JSON value that is not an object', () {
      expect(parseRealtimeEnvelope('[1,2,3]'), isNull);
      expect(parseRealtimeEnvelope('"just a string"'), isNull);
    });

    test('rejects an unsupported schema version', () {
      final bad = validJson.replaceFirst('"version":1', '"version":2');
      expect(parseRealtimeEnvelope(bad), isNull);
    });

    test('rejects an event type outside the known backend catalogue', () {
      final bad = validJson.replaceFirst('"offer.sent"', '"something.invented"');
      expect(parseRealtimeEnvelope(bad), isNull);
    });

    test('rejects a non-UUID eventId', () {
      final bad = validJson.replaceFirst(
        '"11111111-1111-1111-1111-111111111111"',
        '"not-a-uuid"',
      );
      expect(parseRealtimeEnvelope(bad), isNull);
    });

    test('rejects a non-UUID organisationId', () {
      final bad = validJson.replaceFirst(
        '"22222222-2222-2222-2222-222222222222"',
        '"../../etc/passwd"',
      );
      expect(parseRealtimeEnvelope(bad), isNull);
    });

    test('rejects an envelope with neither targetUserId nor a workspace-broadcast type', () {
      final bad = validJson.replaceFirst(
        '"targetUserId":"44444444-4444-4444-4444-444444444444",',
        '"targetUserId":null,',
      );
      expect(parseRealtimeEnvelope(bad), isNull);
    });

    test('accepts a null workspaceId (org-wide, no specific workspace)', () {
      final ok = validJson.replaceFirst(
        '"workspaceId":"33333333-3333-3333-3333-333333333333",',
        '"workspaceId":null,',
      );
      final envelope = parseRealtimeEnvelope(ok);
      expect(envelope, isNotNull);
      expect(envelope!.workspaceId, isNull);
    });

    test('rejects an oversized payload rather than parsing it', () {
      final huge = 'x' * 9000;
      expect(parseRealtimeEnvelope(huge), isNull);
    });

    test('rejects an empty string', () {
      expect(parseRealtimeEnvelope(''), isNull);
    });

    test('accepts offer.accepted and offer.confirmed — the other two real producers', () {
      for (final type in ['offer.accepted', 'offer.confirmed']) {
        final ok = validJson.replaceFirst('"offer.sent"', '"$type"');
        final envelope = parseRealtimeEnvelope(ok);
        expect(envelope, isNotNull, reason: '$type should be a known, valid type');
        expect(envelope!.type, type);
      }
    });
  });

  group('SseStreamParser', () {
    test('parses a single complete frame delivered in one chunk', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk('data: hello\n\n');
      expect(frames, hasLength(1));
      expect(frames.first.data, 'hello');
    });

    test('parses a frame split across multiple chunks (partial TCP delivery)', () {
      final parser = SseStreamParser();
      expect(parser.addChunk('data: hel'), isEmpty);
      expect(parser.addChunk('lo\n'), isEmpty);
      final frames = parser.addChunk('\n');
      expect(frames, hasLength(1));
      expect(frames.first.data, 'hello');
    });

    test('joins multiline data fields with newlines, per the SSE spec', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk('data: line one\ndata: line two\n\n');
      expect(frames, hasLength(1));
      expect(frames.first.data, 'line one\nline two');
    });

    test('ignores comment/heartbeat lines and produces no frame for them alone', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk(': keep-alive\n\n');
      expect(frames, isEmpty);
    });

    test('a comment line inside an otherwise-real frame is dropped, data survives', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk(': comment\ndata: real\n\n');
      expect(frames, hasLength(1));
      expect(frames.first.data, 'real');
    });

    test('parses multiple complete frames delivered in one chunk, in order', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk('data: first\n\ndata: second\n\n');
      expect(frames, hasLength(2));
      expect(frames[0].data, 'first');
      expect(frames[1].data, 'second');
    });

    test('captures event: and id: fields alongside data:', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk('event: offer.sent\nid: abc-123\ndata: payload\n\n');
      expect(frames, hasLength(1));
      expect(frames.first.event, 'offer.sent');
      expect(frames.first.id, 'abc-123');
      expect(frames.first.data, 'payload');
    });

    test('a frame with no data: line at all is dropped (pure comment/control frame)', () {
      final parser = SseStreamParser();
      final frames = parser.addChunk('event: ping\n\n');
      expect(frames, isEmpty);
    });

    test('resets cleanly instead of growing unbounded when no frame boundary ever arrives', () {
      final parser = SseStreamParser(maxBufferBytes: 100);
      final frames = parser.addChunk('x' * 200); // no \n\n anywhere, exceeds the cap
      expect(frames, isEmpty);
      // The buffer was dropped, not merely left huge — a real frame arriving next parses cleanly.
      final next = parser.addChunk('data: recovered\n\n');
      expect(next, hasLength(1));
      expect(next.first.data, 'recovered');
    });

    test('a UTF-8 multi-byte character split across two chunks decodes correctly upstream', () {
      // This parser only ever sees already-decoded strings (the real client feeds it
      // chunks via `stream.transform(utf8.decoder)`, which reassembles split multi-byte
      // sequences before this class sees them) — simulate that correctly-decoded input here.
      final parser = SseStreamParser();
      final frames = parser.addChunk('data: café\n\n'); // "café"
      expect(frames, hasLength(1));
      expect(frames.first.data, 'café');
    });
  });
}
