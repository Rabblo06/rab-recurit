import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../auth/auth_provider.dart';
import '../theme/schedule_tokens.dart';

/// A venue's profile photo, fetched with the signed-in session from
/// `GET /files/:id` (the server decides who may read it). Without a photo, or
/// while loading or after any failure, it shows the same-sized venue icon
/// placeholder, never a broken image.
class VenuePhoto extends StatefulWidget {
  const VenuePhoto({
    super.key,
    required this.fileId,
    required this.size,
    this.circle = false,
    this.radius = 12,
    this.placeholderColor = ScheduleTokens.lavender,
    this.iconSize,
    this.iconAlignment = Alignment.center,
    this.semanticLabel,
  });
  final String? fileId;
  final double size;
  final bool circle;
  final double radius;
  final Color placeholderColor;
  final double? iconSize;

  /// Where the placeholder icon sits; a partly covered photo moves it into
  /// the visible part of the circle.
  final Alignment iconAlignment;
  final String? semanticLabel;

  /// In-memory cache keyed by signed-in user + file id, so bytes authorised
  /// for one account are never shown to another account on the same device.
  static final _cache = <String, Future<Uint8List?>>{};
  static const _maxEntries = 40;

  static void clearCache() => _cache.clear();

  @override
  State<VenuePhoto> createState() => _VenuePhotoState();
}

class _VenuePhotoState extends State<VenuePhoto> {
  Future<Uint8List?>? _bytes;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _bytes ??= _load();
  }

  @override
  void didUpdateWidget(covariant VenuePhoto oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.fileId != widget.fileId) _bytes = _load();
  }

  Future<Uint8List?>? _load() {
    final id = widget.fileId;
    if (id == null || id.isEmpty) return null;
    AuthProvider? auth;
    try {
      auth = Provider.of<AuthProvider>(context, listen: false);
    } on ProviderNotFoundException {
      return null;
    }
    final api = auth.api;
    final key = '${auth.user?.id ?? '-'}:$id';
    final cached = VenuePhoto._cache[key];
    if (cached != null) return cached;
    if (VenuePhoto._cache.length >= VenuePhoto._maxEntries) {
      VenuePhoto._cache.remove(VenuePhoto._cache.keys.first);
    }
    final future = api
        .getBytes('/files/${Uri.encodeComponent(id)}')
        .then<Uint8List?>((bytes) => bytes.isEmpty ? null : bytes)
        // A denied (404, e.g. a finished shift) or failed load is remembered
        // for the session as "no photo", so cards don't re-request it.
        .catchError((Object _) => null);
    return VenuePhoto._cache[key] = future;
  }

  @override
  Widget build(BuildContext context) {
    final borderRadius = BorderRadius.circular(
      widget.circle ? widget.size : widget.radius,
    );
    final placeholder = Container(
      key: const ValueKey('venue-photo-placeholder'),
      width: widget.size,
      height: widget.size,
      decoration: BoxDecoration(
        color: widget.placeholderColor,
        borderRadius: borderRadius,
      ),
      alignment: widget.iconAlignment,
      child: Icon(
        Icons.storefront_outlined,
        size: widget.iconSize ?? widget.size * .5,
        color: ScheduleTokens.ink.withValues(alpha: .55),
      ),
    );
    final future = _bytes;
    final image = future == null
        ? placeholder
        : FutureBuilder<Uint8List?>(
            future: future,
            builder: (context, snapshot) {
              final bytes = snapshot.data;
              if (bytes == null) return placeholder;
              return ClipRRect(
                borderRadius: borderRadius,
                child: Image.memory(
                  bytes,
                  key: const ValueKey('venue-photo-image'),
                  width: widget.size,
                  height: widget.size,
                  fit: BoxFit.cover,
                  gaplessPlayback: true,
                  cacheWidth:
                      (widget.size * MediaQuery.devicePixelRatioOf(context))
                          .round(),
                  errorBuilder: (_, _, _) => placeholder,
                ),
              );
            },
          );
    return Semantics(
      image: true,
      label: widget.semanticLabel,
      child: ExcludeSemantics(child: image),
    );
  }
}
