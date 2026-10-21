import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:pdfx/pdfx.dart';
import 'package:share_plus/share_plus.dart';

// Shared by Venue Manager timesheets and Staff payslips/statements.

/// Saves already-downloaded document bytes. Android 10+: the public Downloads collection via MediaStore
/// (`MainActivity` channel `rab/downloads`, no storage permission). Older Android and iOS: the system share sheet
/// ("Save to Files"). Returns a human description of where it went.
abstract class DocumentSaver {
  Future<String> save(Uint8List bytes, String filename);
}

class PlatformDocumentSaver implements DocumentSaver {
  const PlatformDocumentSaver();
  static const _channel = MethodChannel('rab/downloads');

  @override
  Future<String> save(Uint8List bytes, String filename) async {
    if (Platform.isAndroid) {
      final uri = await _channel.invokeMethod<String>('saveToDownloads', {
        'bytes': bytes,
        'filename': filename,
        'mimeType': 'application/pdf',
      });
      if (uri != null) return 'Saved to Downloads as $filename';
    }
    final dir = await getTemporaryDirectory();
    final file = File('${dir.path}/$filename');
    await file.writeAsBytes(bytes, flush: true);
    await SharePlus.instance.share(
      ShareParams(
        files: [XFile(file.path, mimeType: 'application/pdf')],
        subject: filename,
      ),
    );
    return 'Choose where to save $filename';
  }
}

/// Real PDF pages: pinch to zoom, scroll between pages (pdfx: Android PdfRenderer / iOS PDFKit, no network access).
/// pdfx's pinch viewer exists only on the mobile platforms this app ships to; anywhere else a plain notice is shown.
Widget defaultPdfView(Uint8List bytes) => Platform.isAndroid || Platform.isIOS
    ? _PdfPages(bytes: bytes)
    : const Center(
        child: Text('The PDF preview is available in the mobile app.'),
      );

class _PdfPages extends StatefulWidget {
  const _PdfPages({required this.bytes});
  final Uint8List bytes;
  @override
  State<_PdfPages> createState() => _PdfPagesState();
}

class _PdfPagesState extends State<_PdfPages> {
  late final PdfControllerPinch _controller = PdfControllerPinch(
    document: PdfDocument.openData(widget.bytes),
  );

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PdfViewPinch(
    controller: _controller,
    backgroundDecoration: const BoxDecoration(color: Color(0xFFEDEEF1)),
    builders: PdfViewPinchBuilders<DefaultBuilderOptions>(
      options: const DefaultBuilderOptions(),
      documentLoaderBuilder: (_) =>
          const Center(child: CircularProgressIndicator()),
      pageLoaderBuilder: (_) =>
          const Center(child: CircularProgressIndicator()),
      errorBuilder: (_, _) =>
          const Center(child: Text('This PDF could not be displayed.')),
    ),
  );
}
