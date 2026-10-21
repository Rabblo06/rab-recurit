import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import 'payroll_document_screen.dart';
import 'payroll_documents.dart';

/// Staff payroll documents, from the server only:
/// - Official payslips (`GET /payroll/me/payslips`): the agency's fortnightly
///   payslip per payroll period — the payroll provider's PDF uploaded after a
///   finalised run, on the agency calendar's payday.
/// - Approved Shift Statements (`GET /payroll/me/statements`): one per
///   payroll-approved shift.
/// Approval is not payment: nothing says "Paid" unless the server reports a
/// confirmed payment, and net pay is only ever the provider document's figure.
class PayslipsScreen extends StatefulWidget {
  const PayslipsScreen({super.key, this.api});

  /// Test seam; production reads the signed-in session's client.
  final ApiClient? api;

  @override
  State<PayslipsScreen> createState() => _PayslipsScreenState();
}

class _PayslipsScreenState extends State<PayslipsScreen> {
  List<ApprovedShiftStatement> _statements = [];
  List<OfficialPayslip> _payslips = [];
  bool _loading = true;
  String? _error;
  int? _year;

  ApiClient get _api => widget.api ?? context.read<AuthProvider>().api;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _load());
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final (statementsBody, payslipsBody) = await (
        _api.get('/payroll/me/statements?limit=100'),
        _api.get('/payroll/me/payslips'),
      ).wait;
      final statements =
          ((statementsBody as Map<String, dynamic>)['data'] as List<dynamic>)
              .map(
                (e) =>
                    ApprovedShiftStatement.fromJson(e as Map<String, dynamic>),
              )
              .toList()
            ..sort((a, b) => b.startsAt.compareTo(a.startsAt));
      final payslips =
          ((payslipsBody as Map<String, dynamic>)['data'] as List<dynamic>)
              .map((e) => OfficialPayslip.fromJson(e as Map<String, dynamic>))
              .toList()
            ..sort((a, b) => b.payday.compareTo(a.payday));
      if (!mounted) return;
      setState(() {
        _statements = statements;
        _payslips = payslips;
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = userMessageFor(
            e,
            fallback: 'Your payroll documents could not be loaded.',
          ),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  void _openDocument(String fileId, String? filename, String title) =>
      Navigator.of(context).push(
        MaterialPageRoute<void>(
          builder: (_) => PayrollDocumentScreen(
            fileId: fileId,
            filename: filename,
            title: title,
          ),
        ),
      );

  void _openPayslip(OfficialPayslip p) {
    if (p.hasDocument) _openDocument(p.fileId!, p.filename, 'Payslip');
  }

  void _openStatement(ApprovedShiftStatement s) {
    if (s.available) _openDocument(s.fileId!, s.filename, 'Shift statement');
  }

  @override
  Widget build(BuildContext context) {
    final years = {
      for (final s in _statements) s.startsAt.toLocal().year,
    }.toList()..sort((a, b) => b.compareTo(a));
    final year = _year ?? (years.isEmpty ? DateTime.now().year : years.first);
    final shown = _statements
        .where((s) => s.startsAt.toLocal().year == year)
        .toList();
    final nextPayday = _payslips
        .where((p) => p.status == 'upcoming' || p.status == 'processing')
        .map((p) => p.payday)
        .fold<DateTime?>(
          null,
          (min, d) => min == null || d.isBefore(min) ? d : min,
        );
    return Scaffold(
      backgroundColor: ScheduleTokens.background,
      body: SafeArea(
        bottom: false,
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(8, 4, 8, 0),
              child: ScheduleNavHeader(title: 'Payslips'),
            ),
            Expanded(
              child: RefreshIndicator(
                color: ScheduleTokens.accent,
                onRefresh: _load,
                child: ListView(
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: EdgeInsets.fromLTRB(
                    20,
                    8,
                    20,
                    MediaQuery.viewPaddingOf(context).bottom + 32,
                  ),
                  children: [
                    if (_loading && _statements.isEmpty && _payslips.isEmpty)
                      const Padding(
                        padding: EdgeInsets.all(48),
                        child: Center(child: CircularProgressIndicator()),
                      )
                    else if (_error != null)
                      ScheduleMessageCard(
                        title: 'Payslips unavailable',
                        message: _error,
                        kind: ScheduleMessageKind.error,
                        actionLabel: 'Retry',
                        onAction: _load,
                      )
                    else ...[
                      _SummaryCard(
                        latest: _statements.firstOrNull,
                        payslip: _payslips
                            .where((p) => p.hasDocument)
                            .firstOrNull,
                        nextPayday: nextPayday,
                        onOpenPayslip: _openPayslip,
                      ),
                      const SizedBox(height: 24),
                      const _SectionTitle('Official payslips'),
                      const SizedBox(height: 12),
                      if (_payslips.isEmpty)
                        const _EmptyRow(
                          key: ValueKey('payslips-empty'),
                          icon: Icons.receipt_long_outlined,
                          title: 'No official payslips available yet',
                          message:
                              'Your fortnightly payslips appear here once your agency publishes them.',
                        )
                      else
                        _RowList(
                          children: [
                            for (final p in _payslips)
                              _PayslipRow(payslip: p, onOpen: _openPayslip),
                          ],
                        ),
                      const SizedBox(height: 24),
                      Row(
                        children: [
                          const Expanded(
                            child: _SectionTitle('Approved shift statements'),
                          ),
                          if (years.length > 1)
                            PopupMenuButton<int>(
                              tooltip: 'Choose year',
                              initialValue: year,
                              onSelected: (y) => setState(() => _year = y),
                              itemBuilder: (_) => [
                                for (final y in years)
                                  PopupMenuItem(value: y, child: Text('$y')),
                              ],
                              child: _YearChip(year: year),
                            )
                          else
                            _YearChip(year: year),
                        ],
                      ),
                      const SizedBox(height: 12),
                      if (shown.isEmpty)
                        const _EmptyRow(
                          key: ValueKey('statements-empty'),
                          icon: Icons.description_outlined,
                          title: 'No approved shift statements yet',
                          message:
                              'A statement appears here once your manager approves the payroll for a shift.',
                        )
                      else
                        _RowList(
                          children: [
                            for (final s in shown)
                              _StatementRow(
                                statement: s,
                                onOpen: _openStatement,
                              ),
                          ],
                        ),
                      const SizedBox(height: 14),
                      const Text(
                        'Statements confirm approved shift earnings. They are not proof of payment; pay arrives on the agency payday.',
                        style: ScheduleType.caption,
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _date(DateTime d, [String pattern = 'd MMM']) =>
    DateFormat(pattern).format(d);

String _paydayText(DateTime? payday) => payday == null
    ? 'Payday to be confirmed'
    : 'Payday ${_date(payday, 'd MMM yyyy')}';

(String, Color, Color) _statusPill(String status) => switch (status) {
  'paid' => ('Paid', const Color(0xFFD6EFE2), const Color(0xFF0B6B47)),
  'available' => (
    'Available',
    const Color(0xFFDCE4FF),
    const Color(0xFF3B41A8),
  ),
  'upcoming' => ('Upcoming', const Color(0xFFEDEEF2), ScheduleTokens.muted),
  'processing' => (
    'Processing',
    const Color(0xFFFFE9C7),
    const Color(0xFF8A4B00),
  ),
  _ => ('Approved', const Color(0xFFDCE4FF), const Color(0xFF3B41A8)),
};

class _Pill extends StatelessWidget {
  const _Pill(this.status);
  final String status;
  @override
  Widget build(BuildContext context) {
    final (label, bg, fg) = _statusPill(status);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(8),
      ),
      child: Text(
        label,
        style: ScheduleType.badge.copyWith(fontSize: 12, color: fg),
      ),
    );
  }
}

/// Latest official payslip with a document when there is one; otherwise the
/// latest approved shift. Labels say which, so approval never reads as pay.
class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.latest,
    this.payslip,
    this.nextPayday,
    this.onOpenPayslip,
  });
  final ApprovedShiftStatement? latest;
  final OfficialPayslip? payslip;
  final DateTime? nextPayday;
  final ValueChanged<OfficialPayslip>? onOpenPayslip;

  @override
  Widget build(BuildContext context) {
    final p = payslip, s = latest;
    final heading = p != null
        ? 'Latest payslip'
        : s != null
        ? 'Latest approved shift'
        : 'Approved earnings';
    final amount = p != null
        ? (p.netPence == null ? '—' : formatPence(p.netPence!))
        : s?.amountPence == null
        ? null
        : formatPence(s!.amountPence!);
    final amountLabel = p != null
        ? (p.netPence == null ? 'Net pay on payslip' : 'Net pay')
        : 'Approved gross';
    final detail = p != null
        ? p.periodLabel
        : s != null
        ? '${_date(s.startsAt.toLocal(), 'EEE d MMMM yyyy')} · ${s.venueName}'
        : 'Approved shift earnings appear here after your manager approves payroll.';
    final footer = p != null
        ? '${p.status == 'paid' && p.paidAt != null ? 'Paid on ${_date(p.paidAt!.toLocal())}' : 'Payday ${_date(p.payday)}'} · View payslip ↗'
        : nextPayday != null
        ? 'Next payday ${_date(nextPayday!, 'd MMM yyyy')}'
        : s != null
        ? _paydayText(s.payday)
        : null;
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 18, 20, 20),
      decoration: BoxDecoration(
        color: ScheduleTokens.navy,
        borderRadius: BorderRadius.circular(ScheduleTokens.cardRadius),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  heading,
                  style: ScheduleType.secondary.copyWith(color: Colors.white),
                ),
              ),
              if (p != null)
                _Pill(p.status)
              else if (s != null)
                _Pill(s.status),
            ],
          ),
          const SizedBox(height: 12),
          if (amount == null)
            Text(
              'Nothing approved yet',
              style: ScheduleType.cardTitle.copyWith(
                fontSize: 24,
                color: Colors.white,
              ),
            )
          else
            Wrap(
              crossAxisAlignment: WrapCrossAlignment.end,
              spacing: 10,
              children: [
                Text(
                  amount,
                  style: ScheduleType.timer.copyWith(
                    fontSize: 40,
                    fontWeight: FontWeight.w700,
                    color: Colors.white,
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.only(bottom: 6),
                  child: Text(
                    amountLabel,
                    style: ScheduleType.secondary.copyWith(
                      color: Colors.white70,
                    ),
                  ),
                ),
              ],
            ),
          const SizedBox(height: 10),
          Text(detail, style: ScheduleType.body.copyWith(color: Colors.white)),
          if (footer != null) ...[
            const SizedBox(height: 6),
            InkWell(
              onTap: p != null && onOpenPayslip != null
                  ? () => onOpenPayslip!(p)
                  : null,
              child: Text(
                footer,
                style: ScheduleType.caption.copyWith(color: Colors.white70),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Semantics(
    header: true,
    child: Text(text, style: ScheduleType.cardTitle.copyWith(fontSize: 19)),
  );
}

class _YearChip extends StatelessWidget {
  const _YearChip({required this.year});
  final int year;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(12),
      border: Border.all(color: ScheduleTokens.border),
    ),
    child: Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text('$year', style: ScheduleType.secondary),
        const SizedBox(width: 8),
        const Icon(
          Icons.calendar_today_outlined,
          size: 16,
          color: ScheduleTokens.muted,
        ),
      ],
    ),
  );
}

class _EmptyRow extends StatelessWidget {
  const _EmptyRow({
    super.key,
    required this.icon,
    required this.title,
    required this.message,
  });
  final IconData icon;
  final String title, message;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.all(18),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: ScheduleTokens.border),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _DocIcon(icon: icon, muted: true),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(title, style: ScheduleType.bodyStrong),
              const SizedBox(height: 2),
              Text(message, style: ScheduleType.caption),
            ],
          ),
        ),
      ],
    ),
  );
}

class _DocIcon extends StatelessWidget {
  const _DocIcon({this.icon = Icons.description_outlined, this.muted = false});
  final IconData icon;
  final bool muted;
  @override
  Widget build(BuildContext context) => Container(
    width: 44,
    height: 44,
    decoration: BoxDecoration(
      color: muted ? const Color(0xFFEDEEF2) : const Color(0xFFDDF3E8),
      borderRadius: BorderRadius.circular(12),
    ),
    child: Icon(
      icon,
      size: 22,
      color: muted ? ScheduleTokens.muted : const Color(0xFF0B6B47),
    ),
  );
}

class _RowList extends StatelessWidget {
  const _RowList({required this.children});
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => Container(
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(20),
      border: Border.all(color: ScheduleTokens.border),
    ),
    clipBehavior: Clip.antiAlias,
    child: Column(
      children: [
        for (var i = 0; i < children.length; i++) ...[
          if (i > 0) const Divider(height: 1, color: ScheduleTokens.border),
          children[i],
        ],
      ],
    ),
  );
}

class _DocumentRow extends StatelessWidget {
  const _DocumentRow({
    required this.title,
    required this.lines,
    required this.amount,
    required this.action,
    required this.hasDocument,
    this.actionColor,
    this.onTap,
  });
  final String title, amount, action;
  final List<String> lines;
  final bool hasDocument;
  final Color? actionColor;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) => InkWell(
    onTap: onTap,
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
      child: Row(
        children: [
          _DocIcon(muted: !hasDocument),
          const SizedBox(width: 14),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(title, style: ScheduleType.bodyStrong),
                for (final line in lines)
                  Text(
                    line,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ScheduleType.caption,
                  ),
              ],
            ),
          ),
          const SizedBox(width: 8),
          Column(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: [
              Text(
                amount,
                style: ScheduleType.bodyStrong.copyWith(fontSize: 16),
              ),
              Text(
                action,
                style: ScheduleType.caption.copyWith(color: actionColor),
              ),
            ],
          ),
        ],
      ),
    ),
  );
}

class _PayslipRow extends StatelessWidget {
  const _PayslipRow({required this.payslip, required this.onOpen});
  final OfficialPayslip payslip;
  final ValueChanged<OfficialPayslip> onOpen;

  @override
  Widget build(BuildContext context) {
    final p = payslip;
    final (label, _, _) = _statusPill(p.status);
    return _DocumentRow(
      title: p.periodLabel,
      lines: [
        p.status == 'paid' && p.paidAt != null
            ? 'Paid ${_date(p.paidAt!.toLocal())}'
            : '$label · payday ${_date(p.payday)}',
      ],
      amount: p.netPence == null ? '—' : formatPence(p.netPence!),
      action: p.hasDocument ? 'View ›' : 'Not available yet',
      hasDocument: p.hasDocument,
      onTap: p.hasDocument ? () => onOpen(p) : null,
    );
  }
}

class _StatementRow extends StatelessWidget {
  const _StatementRow({required this.statement, required this.onOpen});
  final ApprovedShiftStatement statement;
  final ValueChanged<ApprovedShiftStatement> onOpen;

  @override
  Widget build(BuildContext context) {
    final s = statement;
    return _DocumentRow(
      title: _date(s.startsAt.toLocal(), 'EEE d MMM yyyy'),
      lines: [s.venueName, _paydayText(s.payday)],
      amount: s.amountPence == null ? '—' : formatPence(s.amountPence!),
      action: switch (s.statementState) {
        'available' => 'View ›',
        'failed' => 'Unavailable',
        _ => 'Preparing…',
      },
      actionColor: s.statementState == 'failed'
          ? ScheduleTokens.errorText
          : null,
      hasDocument: s.available,
      onTap: s.available ? () => onOpen(s) : null,
    );
  }
}
