import 'dart:convert';

/// Mirrors `rab-server`'s `realtime-envelope.ts` exactly — same schema
/// version, same known-type allow-list, same required/optional field shape.
/// This file is the single place that allow-list lives in Flutter; it must
/// never get ahead of the backend's own `KNOWN_REALTIME_EVENT_TYPES`.
const int realtimeEnvelopeSchemaVersion = 1;

/// Only these two event types are actually produced end-to-end today
/// (`OfferService.sendOne()` / `OfferService.staffAccept()`, see
/// `realtime-event.service.ts`). Adding a type here with no real backend
/// producer is exactly what the Stage 5 brief forbids — do not extend this
/// set speculatively.
const Set<String> knownRealtimeEventTypes = {
  'offer.sent',
  'offer.accepted',
  'offer.confirmed',
};

final RegExp _uuidPattern = RegExp(
  r'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$',
);

bool _looksLikeUuid(String value) => _uuidPattern.hasMatch(value);

class RealtimeEnvelope {
  const RealtimeEnvelope({
    required this.version,
    required this.eventId,
    required this.type,
    required this.organisationId,
    required this.workspaceId,
    required this.targetUserId,
    required this.entityId,
    required this.occurredAt,
  });

  final int version;
  final String eventId;
  final String type;
  final String organisationId;
  final String? workspaceId;
  final String? targetUserId;
  final String entityId;
  final String occurredAt;
}

/// Parses and validates one SSE `data:` payload into a [RealtimeEnvelope],
/// or returns null for anything that doesn't pass every check — malformed
/// JSON, missing/wrong-typed fields, a non-UUID identifier, an unsupported
/// schema version, or an event type outside [knownRealtimeEventTypes].
/// Never throws: a bad frame must never crash the app (Stage 5 §4.2).
RealtimeEnvelope? parseRealtimeEnvelope(String raw) {
  if (raw.isEmpty || raw.length > 8192) return null; // bounded — see the SSE parser's own buffer cap
  Object? decoded;
  try {
    decoded = jsonDecode(raw);
  } catch (_) {
    return null;
  }
  if (decoded is! Map) return null;
  final map = decoded;

  final version = map['version'];
  if (version is! int || version != realtimeEnvelopeSchemaVersion) return null;

  final eventId = map['eventId'];
  if (eventId is! String || !_looksLikeUuid(eventId)) return null;

  final type = map['type'];
  if (type is! String || !knownRealtimeEventTypes.contains(type)) return null;

  final organisationId = map['organisationId'];
  if (organisationId is! String || !_looksLikeUuid(organisationId)) return null;

  final entityId = map['entityId'];
  if (entityId is! String || !_looksLikeUuid(entityId)) return null;

  final occurredAt = map['occurredAt'];
  if (occurredAt is! String || DateTime.tryParse(occurredAt) == null) return null;

  final workspaceIdRaw = map['workspaceId'];
  if (workspaceIdRaw != null && (workspaceIdRaw is! String || !_looksLikeUuid(workspaceIdRaw))) return null;
  final workspaceId = workspaceIdRaw as String?;

  final targetUserIdRaw = map['targetUserId'];
  if (targetUserIdRaw != null && (targetUserIdRaw is! String || !_looksLikeUuid(targetUserIdRaw))) return null;
  final targetUserId = targetUserIdRaw as String?;

  // Every currently-known type is recipient-only (see realtime-envelope.ts's own
  // WORKSPACE_BROADCAST_EVENT_TYPES, empty today) — an envelope with neither a
  // target user nor a workspace broadcast is malformed, never trusted.
  if (targetUserId == null) return null;

  return RealtimeEnvelope(
    version: version,
    eventId: eventId,
    type: type,
    organisationId: organisationId,
    workspaceId: workspaceId,
    targetUserId: targetUserId,
    entityId: entityId,
    occurredAt: occurredAt,
  );
}

/// One complete parsed SSE frame (before envelope validation) — the `data:`
/// field's full (possibly multi-line) payload, plus `event:`/`id:` if sent.
class SseFrame {
  const SseFrame({required this.data, this.event, this.id});
  final String data;
  final String? event;
  final String? id;
}

/// Incremental SSE wire-format parser. Feed it decoded text chunks as they
/// arrive (already UTF-8-decoded by the caller via a `StreamTransformer`,
/// which correctly reassembles a multi-byte character split across two
/// chunks — this class only ever sees whole, valid Dart strings). Handles:
///   - `data:`/`event:`/`id:` fields, one frame ends at the first blank line
///   - multiline `data:` (SSE spec: each `data:` line is joined with `\n`)
///   - comment lines (start with `:`), ignored
///   - partial frames split across multiple chunks (buffered until `\n\n`)
///   - a bounded buffer: if no complete frame arrives within [maxBufferBytes],
///     the buffer is dropped and parsing resumes clean — a single pathological
///     or malicious unbounded line can never grow memory without limit.
class SseStreamParser {
  SseStreamParser({this.maxBufferBytes = 64 * 1024});

  final int maxBufferBytes;
  String _buffer = '';

  /// Returns every complete frame contained in [chunk], in order. Never
  /// throws on malformed input — at worst it yields fewer/no frames.
  List<SseFrame> addChunk(String chunk) {
    _buffer += chunk;
    if (_buffer.length > maxBufferBytes) {
      // Pathological or malicious input with no event boundary at all —
      // reset rather than let this grow unbounded (Stage 5 §4.2).
      _buffer = '';
      return const [];
    }

    final frames = <SseFrame>[];
    int boundary;
    while ((boundary = _buffer.indexOf('\n\n')) != -1) {
      final raw = _buffer.substring(0, boundary);
      _buffer = _buffer.substring(boundary + 2);
      final frame = _parseOneFrame(raw);
      if (frame != null) frames.add(frame);
    }
    return frames;
  }

  SseFrame? _parseOneFrame(String raw) {
    final dataLines = <String>[];
    String? event;
    String? id;
    for (final line in raw.split('\n')) {
      if (line.isEmpty || line.startsWith(':')) continue; // blank/comment — ignore
      if (line.startsWith('data:')) {
        dataLines.add(line.length > 5 && line[5] == ' ' ? line.substring(6) : line.substring(5));
      } else if (line.startsWith('event:')) {
        event = line.substring(6).trim();
      } else if (line.startsWith('id:')) {
        id = line.substring(3).trim();
      }
      // Any other field (e.g. `retry:`) is intentionally ignored — not needed by this client.
    }
    if (dataLines.isEmpty) return null; // a pure heartbeat/comment frame — nothing to dispatch
    return SseFrame(data: dataLines.join('\n'), event: event, id: id);
  }
}
