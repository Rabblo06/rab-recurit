import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'report_ui.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

/// Opens the sign-off sheet for [report]; resolves `true` only after the server confirmed finalisation.
Future<bool> showSignOffSheet(
  BuildContext context,
  ShiftReportDetail report,
) async {
  final provider = context.read<VenueManagerProvider>();
  final sent = await showModalBottomSheet<bool>(
    context: context,
    isScrollControlled: true,
    backgroundColor: Colors.white,
    shape: const RoundedRectangleBorder(
      borderRadius: BorderRadius.vertical(top: Radius.circular(28)),
    ),
    builder: (_) => ChangeNotifierProvider.value(
      value: provider,
      child: SignOffSheet(report: report),
    ),
  );
  return sent == true;
}

/// Manager sign-off: break confirmation + typed full name. The server records who signed and when (`finalised_by` /
/// `finalised_at`); "Sign & send" stays disabled until both are given and the SERVER says the report is ready. One
/// request at a time: the button is busy until the response, and the server is idempotent anyway.
class SignOffSheet extends StatefulWidget {
  const SignOffSheet({super.key, required this.report});
  final ShiftReportDetail report;

  @override
  State<SignOffSheet> createState() => _SignOffSheetState();
}

class _SignOffSheetState extends State<SignOffSheet> {
  final _name = TextEditingController();
  bool _breaks = false, _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _name.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  bool get _ready =>
      widget.report.actions?.canFinalise ?? widget.report.canFinalise;
  bool get _valid => _breaks && _name.text.trim().length >= 2 && _ready;

  Future<void> _send() async {
    if (_sending) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      await context.read<VenueManagerProvider>().finaliseReport(
        widget.report.shiftId,
        signedOffName: _name.text.trim(),
        breakConfirmed: true,
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } catch (_) {
      if (mounted) {
        setState(() => _error = 'Something went wrong. Please try again.');
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final missing = widget.report.missingClockOut;
    return Padding(
      padding: EdgeInsets.fromLTRB(
        24,
        12,
        24,
        16 +
            MediaQuery.viewInsetsOf(context).bottom +
            MediaQuery.paddingOf(context).bottom,
      ),
      child: SingleChildScrollView(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Center(
              child: Container(
                width: 40,
                height: 4,
                decoration: BoxDecoration(
                  color: ReportTokens.divider,
                  borderRadius: BorderRadius.circular(2),
                ),
              ),
            ),
            const SizedBox(height: 18),
            const Text(
              'Sign off the timesheet',
              style: TextStyle(
                fontSize: 22,
                fontWeight: FontWeight.w700,
                color: ReportTokens.ink,
              ),
            ),
            const SizedBox(height: 4),
            const Text(
              'Confirm the report details before sending.',
              style: TextStyle(fontSize: 14, color: ReportTokens.muted),
            ),
            if (missing > 0 || !_ready) ...[
              const SizedBox(height: 16),
              ReportNotice(
                title: missing > 0
                    ? '$missing staff ${missing == 1 ? 'has' : 'have'} no clock-out recorded.'
                    : 'Attendance still needs attention.',
                message: 'Review these entries before sending.',
              ),
            ],
            const SizedBox(height: 16),
            InkWell(
              key: const Key('confirm-breaks'),
              onTap: _sending ? null : () => setState(() => _breaks = !_breaks),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Checkbox(
                    value: _breaks,
                    onChanged: _sending
                        ? null
                        : (v) => setState(() => _breaks = v ?? false),
                  ),
                  const Expanded(
                    child: Padding(
                      padding: EdgeInsets.only(top: 12),
                      child: Text.rich(
                        TextSpan(
                          text: 'I confirm break details are accurate\n',
                          style: TextStyle(
                            fontSize: 15,
                            color: ReportTokens.ink,
                          ),
                          children: [
                            TextSpan(
                              text: 'and any exceptions are recorded.',
                              style: TextStyle(
                                fontSize: 13,
                                color: ReportTokens.muted,
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 14),
            const Text(
              'Manager signature',
              style: TextStyle(fontSize: 13, color: ReportTokens.muted),
            ),
            const SizedBox(height: 6),
            TextField(
              key: const Key('signature-name'),
              controller: _name,
              enabled: !_sending,
              textCapitalization: TextCapitalization.words,
              textAlign: TextAlign.center,
              style: const TextStyle(fontSize: 18, fontStyle: FontStyle.italic),
              decoration: InputDecoration(
                hintText: 'Type your full name to sign',
                filled: true,
                fillColor: const Color(0xFFF3F4F6),
                contentPadding: const EdgeInsets.symmetric(
                  vertical: 30,
                  horizontal: 14,
                ),
                border: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: const BorderSide(color: ReportTokens.divider),
                ),
                enabledBorder: OutlineInputBorder(
                  borderRadius: BorderRadius.circular(16),
                  borderSide: const BorderSide(color: ReportTokens.divider),
                ),
              ),
            ),
            const SizedBox(height: 6),
            const Text(
              'Your account, the time and this typed name are recorded with the report. It is not a handwritten signature.',
              style: TextStyle(fontSize: 12, color: ReportTokens.muted),
            ),
            if (_error != null) ...[
              const SizedBox(height: 12),
              ScheduleMessageCard(
                title: _error!,
                kind: ScheduleMessageKind.error,
              ),
            ],
            const SizedBox(height: 18),
            ReportButton(
              key: const Key('sign-and-send'),
              label: 'Sign & send',
              busy: _sending,
              onPressed: _valid ? _send : null,
            ),
            const SizedBox(height: 4),
            Center(
              child: TextButton(
                onPressed: _sending
                    ? null
                    : () => Navigator.of(context).pop(false),
                child: const Text(
                  'Back to report',
                  style: TextStyle(color: ReportTokens.muted),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
