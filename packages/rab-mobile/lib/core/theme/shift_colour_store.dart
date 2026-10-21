import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import 'shift_visual_style.dart';

/// Keeps shift colour assignments across cold starts. Presentation only: the
/// file holds hashed keys and palette slots, never shift ids or shift data.
/// Any read/write failure falls back to in-memory colours (colour carries no
/// authority, so failing open here is safe).
class ShiftColourStore {
  ShiftColourStore._(this._file);
  final File _file;
  final _entries = <String, int>{};
  Timer? _pending;

  /// Most recent assignments kept; the oldest are dropped first.
  static const maxEntries = 500;

  static Future<void> attach(ShiftColourRegistry registry) async {
    try {
      final dir = await getApplicationSupportDirectory();
      final store = ShiftColourStore._(File('${dir.path}/shift_colours.json'));
      await store._load();
      registry.restore(store._entries);
      registry.onAssigned = store._remember;
    } catch (error) {
      debugPrint('Shift colours will not persist this session: $error');
    }
  }

  Future<void> _load() async {
    if (!await _file.exists()) return;
    final decoded = jsonDecode(await _file.readAsString());
    if (decoded is! Map<String, dynamic>) return;
    decoded.forEach((key, value) {
      if (value is int) _entries[key] = value;
    });
  }

  void _remember(String key, int slot) {
    _entries
      ..remove(key)
      ..[key] = slot;
    while (_entries.length > maxEntries) {
      _entries.remove(_entries.keys.first);
    }
    _pending?.cancel();
    _pending = Timer(const Duration(milliseconds: 400), _save);
  }

  Future<void> _save() async {
    try {
      await _file.writeAsString(jsonEncode(_entries), flush: true);
    } catch (error) {
      debugPrint('Shift colours not saved: $error');
    }
  }
}
