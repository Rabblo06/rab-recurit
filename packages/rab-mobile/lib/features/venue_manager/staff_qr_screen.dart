import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import 'report_document_screen.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

/// What the Staff Qr-Code frame can truthfully show.
enum StaffQrState { loading, available, notYet, preparing, closed, unavailable, error }

/// Venue Manager "Staff Qr-Code": the shift's real signed QR for staff to
/// scan at Clock In / Clock Out. There is no QR-token or QR-image endpoint
/// for the manager app (server gap, reported); the only server source of the
/// QR is the shift attendance sheet PDF (`actions.preShiftDocument`), so the
/// frame renders that sheet (pinch to zoom). Nothing is drawn or faked here:
/// before the sheet exists, after the QR window closes, or on any failure
/// the frame says so.
class VenueStaffQrScreen extends StatefulWidget {
  const VenueStaffQrScreen({
    super.key,
    required this.shiftId,
    this.viewer = defaultPdfView,
  });
  final String shiftId;
  final Widget Function(Uint8List bytes) viewer;

  @override
  State<VenueStaffQrScreen> createState() => _VenueStaffQrScreenState();
}

class _VenueStaffQrScreenState extends State<VenueStaffQrScreen> {
  StaffQrState _state = StaffQrState.loading;
  ShiftReportDetail? _report;
  Uint8List? _bytes;
  String? _error;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final stamp = ++_generation;
    setState(() {
      _state = StaffQrState.loading;
      _error = null;
    });
    final p = context.read<VenueManagerProvider>();
    try {
      final report = await p.loadReport(widget.shiftId);
      if (report.shiftId != widget.shiftId) {
        throw StateError('The report returned belongs to another shift.');
      }
      final actions = report.actions;
      final doc = actions?.preShiftDocument;
      StaffQrState next;
      Uint8List? bytes;
      if (report.isFinalised || report.qrWindow?.state == 'closed') {
        next = StaffQrState.closed;
      } else if (doc != null) {
        final file = await p.downloadReportDocument(doc.fileId);
        if (!file.isPdf) {
          throw ApiException(502, 'The stored file is not a valid PDF.');
        }
        bytes = file.bytes;
        next = StaffQrState.available;
      } else if (actions == null) {
        next = StaffQrState.unavailable;
      } else if (actions.stage == 'scheduled') {
        next = StaffQrState.notYet;
      } else {
        next = StaffQrState.preparing;
      }
      if (!mounted || stamp != _generation) return;
      setState(() {
        _report = report;
        _bytes = bytes;
        _state = next;
      });
    } catch (e) {
      if (!mounted || stamp != _generation) return;
      setState(() {
        _state = StaffQrState.error;
        _error = e is StateError
            ? "This shift's QR could not be matched. Please try again."
            : e is ApiException && e.statusCode == 404
            ? 'The attendance sheet could not be found. It may still be generating.'
            : userMessageFor(e, fallback: 'The QR code could not be loaded.');
      });
    }
  }

  Widget _message(IconData icon, String title, String body, {bool retry = false}) =>
      Center(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 44, color: Colors.white),
              const SizedBox(height: 12),
              Text(
                title,
                textAlign: TextAlign.center,
                style: ScheduleType.bodyStrong.copyWith(color: Colors.white),
              ),
              const SizedBox(height: 6),
              Text(
                body,
                textAlign: TextAlign.center,
                style: ScheduleType.secondary.copyWith(color: Colors.white70),
              ),
              if (retry) ...[
                const SizedBox(height: 12),
                TextButton(
                  style: TextButton.styleFrom(
                    foregroundColor: Colors.white,
                    minimumSize: const Size(0, 48),
                  ),
                  onPressed: _load,
                  child: const Text('Retry'),
                ),
              ],
            ],
          ),
        ),
      );

  Widget _frameContent() {
    final actions = _report?.actions;
    return switch (_state) {
      StaffQrState.loading => const Center(
        child: CircularProgressIndicator(color: Colors.white),
      ),
      StaffQrState.available => ColoredBox(
        key: const ValueKey('staff-qr-sheet'),
        color: Colors.white,
        child: widget.viewer(_bytes!),
      ),
      StaffQrState.notYet => _message(
        Icons.apartment_outlined,
        'QR not available yet',
        actions == null
            ? 'The shift QR appears here before the shift starts.'
            : 'The shift QR is available from ${DateFormat('HH:mm, EEE d MMM').format(actions.timesheetAvailableAt.toLocal())}.',
      ),
      StaffQrState.preparing => _message(
        Icons.hourglass_top,
        'Preparing the shift QR',
        'The attendance sheet with the QR is being generated.',
        retry: true,
      ),
      StaffQrState.closed => _message(
        Icons.lock_clock_outlined,
        'QR window closed',
        "This shift's clock-in/out window has closed, so its QR is no longer used.",
      ),
      StaffQrState.unavailable => _message(
        Icons.apartment_outlined,
        'QR not available for this shift',
        'The server did not provide a QR for this shift.',
      ),
      StaffQrState.error => _message(
        Icons.error_outline,
        'QR not available',
        _error ?? 'The QR code could not be loaded.',
        retry: true,
      ),
    };
  }

  @override
  Widget build(BuildContext context) {
    final available = _state == StaffQrState.available;
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              ScheduleNavHeader(
                title: 'Your workspace',
                backgroundColor: Colors.transparent,
                titleStyle: ScheduleType.body.copyWith(
                  fontWeight: FontWeight.w500,
                ),
                trailing: available
                    ? PopupMenuButton<String>(
                        key: const ValueKey('staff-qr-menu'),
                        tooltip: 'More',
                        icon: const Icon(Icons.more_horiz),
                        onSelected: (_) => Navigator.of(context).push(
                          MaterialPageRoute<void>(
                            builder: (_) => ReportDocumentScreen(
                              shiftId: widget.shiftId,
                              showPreShift: true,
                            ),
                          ),
                        ),
                        itemBuilder: (_) => const [
                          PopupMenuItem(
                            value: 'sheet',
                            child: Text('Open attendance sheet'),
                          ),
                        ],
                      )
                    : null,
              ),
              const SizedBox(height: 12),
              Expanded(
                child: ListView(
                  children: [
                    Text(
                      'Staff Qr-Code',
                      style: ScheduleTokens.heading.copyWith(fontSize: 22),
                    ),
                    const SizedBox(height: 8),
                    Text(
                      "Staff align the venue's code inside their scanner frame.",
                      style: ScheduleType.secondary,
                    ),
                    const SizedBox(height: 18),
                    AspectRatio(
                      aspectRatio: .86,
                      child: ClipRRect(
                        key: const ValueKey('staff-qr-frame'),
                        borderRadius: BorderRadius.circular(18),
                        child: ColoredBox(
                          color: ScheduleTokens.navy,
                          child: _frameContent(),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: 12),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.all(16),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  available
                      ? 'Qr-preview · scan the QR-Code on this attendance sheet to clock-in/out. Pinch to zoom.'
                      : 'Qr-preview · scan this QR-Code displayed here to clock-in/out the staff.',
                  style: ScheduleType.caption,
                ),
              ),
              const SizedBox(height: 12),
              SchedulePrimaryButton(
                label: 'Back',
                background: ScheduleTokens.navy,
                onPressed: () => Navigator.maybePop(context),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
