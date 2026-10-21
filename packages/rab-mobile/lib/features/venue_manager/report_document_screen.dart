import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/pdf_document.dart';
import '../../core/widgets/schedule_toast.dart';
export '../../core/widgets/pdf_document.dart'
    show DocumentSaver, PlatformDocumentSaver, defaultPdfView;
import 'report_ui.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

/// Pill for the final timesheet's delivery (`deliveryState` from the email outbox — never from the finalise response).
(String, ReportBadgeTone, IconData?) deliveryBadge(String state) =>
    switch (state) {
      'sent' => ('Sent', ReportBadgeTone.reviewed, Icons.check),
      'queued' => ('Queued for delivery', ReportBadgeTone.info, null),
      'generating' => ('Generating PDF', ReportBadgeTone.info, null),
      'failed' ||
      'no_recipients' => ('Delivery failed', ReportBadgeTone.needsReview, null),
      _ => ('Finalising', ReportBadgeTone.info, null),
    };

const _notPdf = 'The stored file is not a valid PDF.';

/// "Time-sheet": the shift attendance sheet (before / during the shift, with the Shift QR) or the final timesheet
/// (after finalisation), exactly as the server's `actions.document` says. Bytes come from the authorised download
/// endpoint; nothing is fetched from a public URL and no storage key is ever exposed.
class ReportDocumentScreen extends StatefulWidget {
  const ReportDocumentScreen({
    super.key,
    required this.shiftId,
    this.showPreShift = false,
    this.viewer = defaultPdfView,
    this.saver = const PlatformDocumentSaver(),
  });
  final String shiftId;

  /// Open the earlier shift attendance sheet even when a final timesheet exists.
  final bool showPreShift;
  final Widget Function(Uint8List bytes) viewer;
  final DocumentSaver saver;

  @override
  State<ReportDocumentScreen> createState() => _ReportDocumentScreenState();
}

class _ReportDocumentScreenState extends State<ReportDocumentScreen> {
  ShiftReportDetail? _report;
  ReportDocument? _doc;
  DownloadedFile? _file;
  String? _error;
  bool _loading = true, _saving = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    final p = context.read<VenueManagerProvider>();
    try {
      final report = await p.loadReport(widget.shiftId);
      final actions = report.actions;
      final doc = widget.showPreShift
          ? actions?.preShiftDocument
          : actions?.document;
      DownloadedFile? file;
      if (doc != null) {
        file = await p.downloadReportDocument(doc.fileId);
        if (!file.isPdf) {
          throw ApiException(502, _notPdf);
        }
      }
      if (!mounted) return;
      setState(() {
        _report = report;
        _doc = doc;
        _file = file;
      });
    } on ApiException catch (e) {
      if (mounted) {
        setState(
          () => _error = e.statusCode == 404
              ? 'The PDF could not be found in storage. It may still be generating, or it needs to be regenerated.'
              : e.message == _notPdf
              ? _notPdf
              : e.userMessage,
        );
      }
    } catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'The document could not be loaded. Check your connection and try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _download() async {
    final file = _file, doc = _doc;
    if (file == null || doc == null || _saving) return;
    setState(() => _saving = true);
    // Captured before the save: the toast still reaches the root overlay if
    // this screen is closed while the share sheet is open.
    final overlay = ScheduleToast.overlayOf(context);
    try {
      final name = (file.filename ?? doc.filename).replaceAll(
        RegExp(r'[^A-Za-z0-9._-]'),
        '_',
      );
      // Owner decision: no success toast in the mobile app; only a failure
      // is announced.
      await widget.saver.save(file.bytes, name);
    } catch (_) {
      // Download stays on screen, so retrying is one tap away.
      if (overlay != null) {
        ScheduleToast.showOn(
          overlay,
          'The PDF could not be saved. Tap Download PDF to try again.',
          kind: ScheduleMessageKind.error,
        );
      }
    } finally {
      if (mounted) setState(() => _saving = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final doc = _doc;
    final actions = _report?.actions;
    final isFinal = doc?.isFinal ?? false;
    final title = isFinal ? 'Final timesheet' : 'Shift attendance sheet';
    final subtitle = isFinal
        ? 'After shift · recorded hours and feedback'
        : 'Before shift · QR clock-in / out included';
    final finalPending =
        actions?.finalDocumentPending == true && !widget.showPreShift;

    Widget body;
    if (_loading) {
      body = const Center(child: CircularProgressIndicator());
    } else if (_error != null) {
      body = _message(
        key: const Key('document-error'),
        title: 'Document unavailable',
        message: _error!,
      );
    } else if (doc == null || _file == null) {
      body = _message(
        key: const Key('document-preparing'),
        title: 'Preparing your time-sheet',
        message:
            'The attendance sheet is generated automatically before the shift. Check again in a moment.',
      );
    } else {
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (finalPending)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: ReportNotice(
                title: deliveryBadge(
                  _report!.lifecycle?.deliveryState ?? 'generating',
                ).$1,
                message:
                    'The final timesheet is being prepared. This is the earlier shift attendance sheet.',
              ),
            ),
          Expanded(
            child: Container(
              key: const Key('pdf-preview'),
              margin: const EdgeInsets.symmetric(horizontal: 20),
              clipBehavior: Clip.antiAlias,
              decoration: BoxDecoration(
                color: Colors.white,
                borderRadius: BorderRadius.circular(16),
              ),
              child: widget.viewer(_file!.bytes),
            ),
          ),
          const Padding(
            padding: EdgeInsets.fromLTRB(20, 10, 20, 12),
            child: Text(
              'Pinch to zoom · Scroll to view pages',
              style: TextStyle(fontSize: 13, color: ReportTokens.muted),
            ),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 20),
            child: ReportCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    isFinal
                        ? 'Attendance, ratings and sign-off'
                        : 'Staff profiles and scheduled hours',
                    style: const TextStyle(
                      fontSize: 17,
                      fontWeight: FontWeight.w700,
                      color: ReportTokens.ink,
                    ),
                  ),
                  const SizedBox(height: 4),
                  Text(
                    isFinal
                        ? 'Staff are populated from this shift\'s assignments. Missing records stay clearly marked.'
                        : 'Staff are populated from this shift\'s assignments. The QR is generated by your system for this shift.',
                    style: const TextStyle(
                      fontSize: 13,
                      height: 1.4,
                      color: ReportTokens.muted,
                    ),
                  ),
                  if (isFinal && actions?.preShiftDocument != null)
                    TextButton(
                      key: const Key('open-pre-shift'),
                      style: TextButton.styleFrom(padding: EdgeInsets.zero),
                      onPressed: () => Navigator.of(context).push(
                        MaterialPageRoute<void>(
                          builder: (_) => ReportDocumentScreen(
                            shiftId: widget.shiftId,
                            showPreShift: true,
                            viewer: widget.viewer,
                            saver: widget.saver,
                          ),
                        ),
                      ),
                      child: const Text(
                        'View the shift attendance sheet (before shift)',
                      ),
                    ),
                ],
              ),
            ),
          ),
        ],
      );
    }

    return ReportPage(
      title: title,
      body: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    subtitle,
                    style: const TextStyle(
                      fontSize: 14,
                      color: ReportTokens.muted,
                    ),
                  ),
                ),
                if (isFinal && _report?.lifecycle != null) ...[
                  const SizedBox(width: 8),
                  Builder(
                    builder: (_) {
                      final (label, tone, icon) = deliveryBadge(
                        _report!.lifecycle!.deliveryState,
                      );
                      return ReportBadge(label, tone, icon: icon);
                    },
                  ),
                ],
              ],
            ),
          ),
          Expanded(child: body),
        ],
      ),
      bottom: ReportBottomBar(
        children: [
          if (_error != null || (!_loading && _file == null))
            ReportButton(
              key: const Key('document-retry'),
              label: 'Retry',
              onPressed: _load,
            )
          else
            ReportButton(
              key: const Key('download-pdf'),
              label: 'Download PDF',
              busy: _saving,
              onPressed: _file == null ? null : _download,
            ),
        ],
      ),
    );
  }

  Widget _message({
    required Key key,
    required String title,
    required String message,
  }) => Align(
    alignment: Alignment.topCenter,
    child: Padding(
      key: key,
      padding: const EdgeInsets.all(20),
      child: ReportNotice(title: title, message: message),
    ),
  );
}
