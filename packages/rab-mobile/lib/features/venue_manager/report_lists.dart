import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_toast.dart';
import 'report_event_card.dart';
import 'shift_report.dart';
import 'shift_report_screen.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';

/// Current Reports: upcoming/current shifts, outstanding work, and sent reports for five hours after delivery.
class VenueReportsScreen extends StatelessWidget {
  const VenueReportsScreen({super.key});

  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Reports',
    child: _guarded(
      const ReportBucketList(
        bucket: 'current',
        heading: 'Event staffing summaries',
        intro:
            'Confirmed positions and remaining requirements.\nTap a shift to view attendance.',
        emptyTitle: 'No current reports.',
        emptyMessage: 'Sent reports move to History five hours after delivery.',
      ),
    ),
  );
}

/// History (bottom tab and My Space row — the same screen): completed shifts, expired actions and sent timesheets.
/// Nothing is deleted to keep Reports short; every record stays openable and downloadable here.
class VenueHistoryScreen extends StatelessWidget {
  const VenueHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) => VmPage(
    title: 'History',
    child: _guarded(
      const ReportBucketList(
        bucket: 'history',
        heading: 'Past shifts and timesheets',
        intro: 'Completed shifts, expired actions and sent timesheets.',
        emptyTitle: 'No historical activity yet.',
        emptyMessage:
            'Shifts appear here five hours after they end, or five hours after their timesheet is sent.',
      ),
    ),
  );
}

/// Same guard as every Venue Manager page: a failed provider refresh (e.g. a revoked permission) replaces the list
/// with the error state and drops its rows; no report permission, no list.
Widget _guarded(Widget list) => VmData(
  keepContentWhileRefreshing: true,
  builder: (p) => p.allows('report.view')
      ? list
      : const Center(
          child: ScheduleMessageCard(
            title: 'Reports are not available for this account.',
            kind: ScheduleMessageKind.error,
          ),
        ),
);

class ReportBucketList extends StatefulWidget {
  const ReportBucketList({
    super.key,
    required this.bucket,
    required this.heading,
    required this.intro,
    required this.emptyTitle,
    required this.emptyMessage,
  });
  final String bucket, heading, intro, emptyTitle, emptyMessage;

  @override
  State<ReportBucketList> createState() => _ReportBucketListState();
}

class _ReportBucketListState extends State<ReportBucketList> {
  static const _pageSize = 30;
  final _rows = <ReportSummary>[];
  int _total = 0, _page = 0;
  bool _loading = true, _loadingMore = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _reload();
  }

  Future<void> _reload() async {
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      final r = await context.read<VenueManagerProvider>().loadReports(
        widget.bucket,
        limit: _pageSize,
      );
      if (!mounted) return;
      setState(() {
        _rows
          ..clear()
          ..addAll(r.rows);
        _total = r.total;
        _page = 1;
      });
    } catch (e) {
      if (mounted) {
        setState(
          () => _error = userMessageFor(e, fallback: 'Could not load reports.'),
        );
      }
    } finally {
      if (mounted) setState(() => _loading = false);
    }
  }

  Future<void> _more() async {
    if (_loadingMore || _rows.length >= _total) return;
    setState(() => _loadingMore = true);
    try {
      final r = await context.read<VenueManagerProvider>().loadReports(
        widget.bucket,
        page: _page + 1,
        limit: _pageSize,
      );
      if (!mounted) return;
      setState(() {
        final seen = _rows.map((x) => x.shiftId).toSet();
        _rows.addAll(r.rows.where((x) => !seen.contains(x.shiftId)));
        _total = r.total;
        _page++;
      });
    } catch (e) {
      // The loaded rows stay usable; only "load more" failed.
      if (mounted) {
        ScheduleToast.showError(
          context,
          e,
          fallback: 'Could not load more reports.',
        );
      }
    } finally {
      if (mounted) setState(() => _loadingMore = false);
    }
  }

  Future<void> _open(ReportSummary r) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ShiftReportScreen(shiftId: r.shiftId),
      ),
    );
    if (mounted) await _reload();
  }

  DateTime? _seenRefresh;

  @override
  Widget build(BuildContext context) {
    // Re-fetch whenever the provider completes a refresh (pull-to-refresh elsewhere, app resume).
    final refreshed = context.select<VenueManagerProvider, DateTime?>(
      (p) => p.updatedAt,
    );
    if (_seenRefresh == null) {
      _seenRefresh = refreshed;
    } else if (refreshed != _seenRefresh) {
      _seenRefresh = refreshed;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _reload();
      });
    }
    if (_loading && _rows.isEmpty) {
      return const Center(child: CircularProgressIndicator());
    }
    return RefreshIndicator(
      onRefresh: _reload,
      child: NotificationListener<ScrollNotification>(
        onNotification: (n) {
          if (n.metrics.pixels > n.metrics.maxScrollExtent - 300) _more();
          return false;
        },
        child: ListView(
          key: PageStorageKey('reports-${widget.bucket}'),
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.all(ScheduleTokens.homeInset),
          children: [
            Text(widget.heading, style: ScheduleTokens.heading),
            const SizedBox(height: 8),
            Text(widget.intro, style: ScheduleTokens.label),
            const SizedBox(height: 20),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: ScheduleMessageCard(
                  title: _error!,
                  kind: ScheduleMessageKind.error,
                ),
              ),
            if (_rows.isEmpty && _error == null)
              ScheduleMessageCard(
                title: widget.emptyTitle,
                message: widget.emptyMessage,
              ),
            for (final r in _rows)
              ReportEventCard(report: r, onTap: () => _open(r)),
            if (_loadingMore)
              const Center(
                child: Padding(
                  padding: EdgeInsets.all(12),
                  child: CircularProgressIndicator(),
                ),
              ),
          ],
        ),
      ),
    );
  }
}
