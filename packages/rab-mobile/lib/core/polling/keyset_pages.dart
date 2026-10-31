import '../api/api_client.dart';

/// Reads every page of a keyset-paged list (API contract §3: `?limit=&cursor=` → `{data, nextCursor}`), first page
/// without a cursor, until `nextCursor` is null. Nothing is truncated: the walk only ends at the server's own end.
///
/// Rollout (a server without keyset paging yet): a 400 on the first page (unknown parameter) or a bare-array answer
/// that may have been cut at [limit] falls back to ONE legacy call of [path] with no parameters, which keeps that
/// server's original default. A bare array shorter than [limit] is already complete.
Future<List<Map<String, dynamic>>> fetchAllKeysetPages(
  ApiClient api,
  String path, {
  required int limit,
  String? query,
  bool background = false,
  int maxPages = 100,
}) async {
  Future<List<Map<String, dynamic>>> legacy() async =>
      ((await api.get(path, background: background)) as List)
          .cast<Map<String, dynamic>>();

  final rows = <Map<String, dynamic>>[];
  final seen = <String>{};
  String? cursor;
  for (var page = 0; page < maxPages; page++) {
    final params = [
      ?query,
      'limit=$limit',
      if (cursor != null) 'cursor=${Uri.encodeQueryComponent(cursor)}',
    ].join('&');
    final Object? response;
    try {
      response = await api.get('$path?$params', background: background);
    } on ApiException catch (e) {
      if (page == 0 && e.statusCode == 400) return legacy();
      rethrow;
    }
    if (response is List) {
      if (page == 0) {
        return response.length < limit
            ? response.cast<Map<String, dynamic>>()
            : legacy();
      }
      throw StateError('The list changed while loading. Please refresh.');
    }
    final map = response as Map;
    rows.addAll((map['data'] as List).cast<Map<String, dynamic>>());
    final next = map['nextCursor'];
    if (next is! String || next.isEmpty) return rows;
    if (!seen.add(next)) {
      throw StateError('The list repeated a page. Please refresh.');
    }
    cursor = next;
  }
  throw StateError('The list is too long to load at once. Please refresh.');
}
