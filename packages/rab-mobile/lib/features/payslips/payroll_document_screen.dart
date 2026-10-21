import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/pdf_document.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/schedule_toast.dart';

/// One of the staff member's own payroll documents (Approved Shift Statement
/// or official payslip). Bytes come only from the authorised
/// `GET /files/:id/download`; the server returns 404 to anyone else.
class PayrollDocumentScreen extends StatefulWidget {
  const PayrollDocumentScreen({
    super.key,
    required this.fileId,
    required this.title,
    this.filename,
    this.viewer = defaultPdfView,
    this.saver = const PlatformDocumentSaver(),
  });
  final String fileId, title;
  final String? filename;
  final Widget Function(Uint8List bytes) viewer;
  final DocumentSaver saver;

  @override
  State<PayrollDocumentScreen> createState() => _PayrollDocumentScreenState();
}

class _PayrollDocumentScreenState extends State<PayrollDocumentScreen> {
  DownloadedFile? _file;
  String? _error;
  bool _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _error = null;
      _file = null;
    });
    try {
      final api = context.read<AuthProvider>().api;
      final file = await api.downloadFile(
        '/files/${Uri.encodeComponent(widget.fileId)}/download',
      );
      if (!mounted) return;
      final isPdf =
          file.bytes.length > 4 &&
          String.fromCharCodes(file.bytes.sublist(0, 4)) == '%PDF';
      setState(() {
        if (isPdf) {
          _file = file;
        } else {
          _error = 'This document could not be displayed.';
        }
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = userMessageFor(
            e,
            fallback: 'This document could not be opened.',
          ),
        );
      }
    }
  }

  Future<void> _save() async {
    final file = _file;
    if (file == null || _saving) return;
    setState(() => _saving = true);
    final overlay = ScheduleToast.overlayOf(context);
    try {
      final name = (file.filename ?? widget.filename ?? 'document.pdf')
          .replaceAll(RegExp(r'[\\/:*?"<>|]'), '_');
      // No success toast in the mobile app (owner decision); only failures.
      await widget.saver.save(file.bytes, name);
    } catch (_) {
      if (overlay != null) {
        ScheduleToast.showOn(
          overlay,
          'The PDF could not be saved. Please try again.',
          kind: ScheduleMessageKind.error,
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final file = _file;
    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: ScheduleNavHeader(title: widget.title),
            ),
            Expanded(
              child: _error != null
                  ? Padding(
                      padding: const EdgeInsets.all(20),
                      child: ScheduleMessageCard(
                        title: 'Document unavailable',
                        message: _error,
                        kind: ScheduleMessageKind.error,
                        actionLabel: 'Retry',
                        onAction: _load,
                      ),
                    )
                  : file == null
                  ? const Center(child: CircularProgressIndicator())
                  : widget.viewer(file.bytes),
            ),
            if (file != null)
              ScheduleBottomAction(
                child: SchedulePrimaryButton(
                  label: 'Download PDF',
                  icon: Icons.download_rounded,
                  busy: _saving,
                  onPressed: _save,
                ),
              ),
          ],
        ),
      ),
    );
  }
}
