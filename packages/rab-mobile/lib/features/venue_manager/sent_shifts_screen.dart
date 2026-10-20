import '../../core/theme/display_labels.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_home_components.dart';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import 'sent_shift.dart';
import 'dart:async';
import '../../core/theme/schedule_tokens.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';
import 'send_shift_screen.dart';

class VenueSentShiftsScreen extends StatefulWidget {
  const VenueSentShiftsScreen({super.key});
  @override
  State<VenueSentShiftsScreen> createState() => _VenueSentShiftsScreenState();
}

class _VenueSentShiftsScreenState extends State<VenueSentShiftsScreen> {
  String query = '';

  /// Server view (`/shifts/sent?view=`): All never contains expired requests; Expired holds only those.
  String view = 'all';
  static const views = <String, String>{
    'all': 'All',
    'pending': 'Pending',
    'accepted': 'Accepted',
    'confirmed': 'Confirmed',
    'declined': 'Declined',
    'expired': 'Expired',
  };
  Future<List<SentShift>>? _viewRows;
  DateTime? _viewLoadedFor;
  Timer? _poll;

  void _select(String next) {
    setState(() {
      view = next;
      _viewRows = next == 'all'
          ? null
          : context.read<VenueManagerProvider>().loadSentView(next);
      _viewLoadedFor = context.read<VenueManagerProvider>().updatedAt;
    });
  }

  @override
  void initState() {
    super.initState();
    _poll = Timer.periodic(const Duration(seconds: 5), (_) {
      if (mounted && (ModalRoute.of(context)?.isCurrent ?? false)) {
        final provider = context.read<VenueManagerProvider>();
        if (!provider.loading) provider.refresh(silent: true);
      }
    });
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Future<void> create() async {
    await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const SendShiftScreen()));
    if (mounted) context.read<VenueManagerProvider>().refresh();
  }

  Future<void> filters() async {
    await showScheduleSheet<void>(
      context: context,
      builder: (sheet) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          for (final entry in views.entries)
            ListTile(
              title: Text(entry.key == 'all' ? 'All shifts' : entry.value),
              trailing: view == entry.key ? const Icon(Icons.check) : null,
              onTap: () {
                Navigator.pop(sheet);
                _select(entry.key);
              },
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: ScheduleTokens.homeBackground,
    body: SafeArea(
      bottom: false,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(18, 8, 18, 10),
            child: Row(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                _CircleButton(
                  diameter: 40,
                  background: Colors.white,
                  tooltip: 'Back',
                  onPressed: () => Navigator.maybePop(context),
                  icon: Icons.chevron_left,
                  iconColor: ScheduleTokens.ink,
                ),
                _CircleButton(
                  diameter: 44,
                  background: ScheduleTokens.accent,
                  tooltip: 'Send Shift',
                  onPressed: create,
                  icon: Icons.add,
                  iconColor: Colors.white,
                ),
              ],
            ),
          ),
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 18),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Sent Shifts',
                  style: TextStyle(
                    fontSize: 23,
                    fontWeight: FontWeight.w700,
                    color: Color(0xFF0F172A),
                  ),
                ),
                SizedBox(height: 3),
                Text(
                  'Track submitted staffing requests',
                  style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Expanded(
            child:
                context.watch<VenueManagerProvider>().loading &&
                    context.watch<VenueManagerProvider>().updatedAt == null
                ? const _SentSkeleton()
                : VmData(
                    keepContentWhileRefreshing: true,
                    builder: (p) {
                      // A tab other than All re-queries the server whenever the provider refreshes (poll / pull).
                      if (view != 'all' && _viewLoadedFor != p.updatedAt) {
                        _viewLoadedFor = p.updatedAt;
                        _viewRows = p.loadSentView(view);
                      }
                      return FutureBuilder<List<SentShift>>(
                        future: _viewRows,
                        builder: (context, snapshot) {
                          final source = view == 'all'
                              ? p.sentShifts
                              : (snapshot.data ?? const <SentShift>[]);
                          final loadingView =
                              view != 'all' &&
                              snapshot.connectionState !=
                                  ConnectionState.done &&
                              snapshot.data == null;
                          final groups = source
                              .where(
                                (shift) => '${shift.venue} ${shift.role}'
                                    .toLowerCase()
                                    .contains(query.toLowerCase()),
                              )
                              .toList();
                          return RefreshIndicator(
                            onRefresh: p.refresh,
                            child: ListView(
                              padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
                              physics: const AlwaysScrollableScrollPhysics(),
                              children: [
                                IntrinsicHeight(
                                  child: Row(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.stretch,
                                    children: [
                                      for (final (label, count, color, icon) in [
                                        (
                                          'Sent',
                                          // Live requests whose offers reached staff (server All view);
                                          // one awaiting manager approval is not "sent" yet.
                                          p.sentShifts
                                              .where((s) => s.counter('sent'))
                                              .length,
                                          const Color(0xFFFFF2E8),
                                          Icons.send_rounded,
                                        ),
                                        (
                                          'Accepted',
                                          p.sentCounts['accepted'] ?? 0,
                                          const Color(0xFFECFDF5),
                                          Icons.check_circle_rounded,
                                        ),
                                        (
                                          'Confirmed',
                                          p.sentCounts['confirmed'] ?? 0,
                                          const Color(0xFFEEF2FF),
                                          Icons.verified_rounded,
                                        ),
                                      ])
                                        Expanded(
                                          child: Padding(
                                            padding: EdgeInsets.only(
                                              right: label == 'Confirmed'
                                                  ? 0
                                                  : 8,
                                            ),
                                            child: _SummaryCard(
                                              label: label,
                                              count: count,
                                              color: color,
                                              icon: icon,
                                            ),
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 16),
                                Row(
                                  children: [
                                    Expanded(
                                      child: Container(
                                        height: 46,
                                        decoration: BoxDecoration(
                                          color: Colors.white,
                                          borderRadius: BorderRadius.circular(
                                            ScheduleTokens.cardRadius,
                                          ),
                                          boxShadow: ScheduleTokens.homeShadows,
                                        ),
                                        child: TextField(
                                          style: const TextStyle(fontSize: 14),
                                          decoration: const InputDecoration(
                                            isDense: true,
                                            hintText: 'Search shifts…',
                                            hintStyle: TextStyle(
                                              fontSize: 14,
                                              color: Color(0xFF94A3B8),
                                            ),
                                            prefixIcon: Icon(
                                              Icons.search,
                                              size: 19,
                                              color: Color(0xFF94A3B8),
                                            ),
                                            filled: true,
                                            fillColor: Colors.white,
                                            border: OutlineInputBorder(
                                              borderRadius: BorderRadius.all(
                                                Radius.circular(23),
                                              ),
                                              borderSide: BorderSide.none,
                                            ),
                                            contentPadding:
                                                EdgeInsets.symmetric(
                                                  vertical: 13,
                                                ),
                                          ),
                                          onChanged: (v) =>
                                              setState(() => query = v),
                                        ),
                                      ),
                                    ),
                                    const SizedBox(width: 8),
                                    _CircleButton(
                                      diameter: 44,
                                      background: Colors.white,
                                      tooltip: 'Filter shifts',
                                      onPressed: filters,
                                      icon: Icons.tune,
                                      iconColor: ScheduleTokens.ink,
                                      shadow: ScheduleTokens.homeShadows,
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 12),
                                SizedBox(
                                  height: 30,
                                  child: ListView(
                                    scrollDirection: Axis.horizontal,
                                    children: [
                                      for (final entry in views.entries)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            right: 6,
                                          ),
                                          child: ChoiceChip(
                                            key: Key('sent-view-${entry.key}'),
                                            label: Text(
                                              '${entry.value} ${p.sentCounts[entry.key] ?? 0}',
                                              style: TextStyle(
                                                fontSize: 11,
                                                color: view == entry.key
                                                    ? Colors.white
                                                    : const Color(0xFF0F172A),
                                              ),
                                            ),
                                            selected: view == entry.key,
                                            showCheckmark: false,
                                            selectedColor: const Color(
                                              0xFF0F172A,
                                            ),
                                            backgroundColor: Colors.white,
                                            side: BorderSide(
                                              color: view == entry.key
                                                  ? const Color(0xFF0F172A)
                                                  : const Color(0xFFE7EAF0),
                                            ),
                                            padding: const EdgeInsets.symmetric(
                                              horizontal: 4,
                                            ),
                                            visualDensity:
                                                VisualDensity.compact,
                                            materialTapTargetSize:
                                                MaterialTapTargetSize
                                                    .shrinkWrap,
                                            onSelected: (_) =>
                                                _select(entry.key),
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                                const SizedBox(height: 16),
                                if (loadingView)
                                  const Padding(
                                    padding: EdgeInsets.all(24),
                                    child: Center(
                                      child: CircularProgressIndicator(),
                                    ),
                                  )
                                else if (snapshot.hasError && view != 'all')
                                  const ScheduleMessageCard(
                                    title:
                                        'Could not load this view. Pull to refresh.',
                                    kind: ScheduleMessageKind.error,
                                  )
                                else if (groups.isEmpty)
                                  Padding(
                                    padding: const EdgeInsets.symmetric(
                                      vertical: 24,
                                    ),
                                    child: Column(
                                      children: [
                                        Text(
                                          (p.sentSubmitted ?? 0) == 0
                                              ? 'No sent shifts yet'
                                              : view == 'expired'
                                              ? 'No expired shifts.'
                                              : 'No sent shifts match this view.',
                                          style: ScheduleTokens.body,
                                        ),
                                        if ((p.sentSubmitted ?? 0) == 0) ...[
                                          const SizedBox(height: 8),
                                          const Text(
                                            'Submit your first staffing request to get started.',
                                            style: ScheduleTokens.label,
                                          ),
                                          const SizedBox(height: 12),
                                          SchedulePrimaryButton(
                                            onPressed: create,
                                            icon: Icons.add,
                                            label: 'Send Shift',
                                          ),
                                        ],
                                      ],
                                    ),
                                  ),
                                for (final group in groups)
                                  SentShiftCard(shift: group),
                              ],
                            ),
                          );
                        },
                      );
                    },
                  ),
          ),
        ],
      ),
    ),
  );
}

class _CircleButton extends StatelessWidget {
  const _CircleButton({
    required this.diameter,
    required this.background,
    required this.tooltip,
    required this.onPressed,
    required this.icon,
    required this.iconColor,
    this.shadow,
  });
  final double diameter;
  final Color background;
  final String tooltip;
  final VoidCallback onPressed;
  final IconData icon;
  final Color iconColor;
  final List<BoxShadow>? shadow;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: diameter,
    height: diameter,
    child: Tooltip(
      message: tooltip,
      child: Material(
        color: background,
        shape: const CircleBorder(),
        elevation: 0,
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: Container(
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              boxShadow: shadow,
            ),
            alignment: Alignment.center,
            child: Icon(icon, size: diameter * 0.45, color: iconColor),
          ),
        ),
      ),
    ),
  );
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({
    required this.label,
    required this.count,
    required this.color,
    required this.icon,
  });
  final String label;
  final int count;
  final Color color;
  final IconData icon;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 11),
    decoration: BoxDecoration(
      color: color,
      borderRadius: BorderRadius.circular(ScheduleTokens.badgeRadius),
    ),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Row(
          children: [
            Icon(
              icon,
              size: 13,
              color: ScheduleTokens.ink.withValues(alpha: .65),
            ),
            const SizedBox(width: 5),
            Flexible(
              child: Text(
                label,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 11,
                  color: ScheduleTokens.ink.withValues(alpha: .65),
                ),
              ),
            ),
          ],
        ),
        const SizedBox(height: 10),
        Text(
          '$count',
          style: const TextStyle(
            fontSize: 22,
            fontWeight: FontWeight.w700,
            color: Color(0xFF0F172A),
          ),
        ),
      ],
    ),
  );
}

/// Sent Shifts card. Pill text and colours come only from [sentShiftLook]
/// (the real server state); the relative time is from `submittedAt`.
class SentShiftCard extends StatelessWidget {
  SentShiftCard({required this.shift, this.openable = true, this.now})
    : super(key: ValueKey('sent-shift-card-${shift.id}'));
  final bool openable;
  final SentShift shift;

  /// Injectable clock for tests; defaults to the device clock (display only).
  final DateTime? now;
  static const _ink = Color(0xFF0F172A);
  static const _grey = Color(0xFF6B7280);
  @override
  Widget build(BuildContext context) {
    final look = sentShiftLook(shift);
    final submitted = shift.submittedAt;
    final sent = shift.count('sent');
    return Padding(
      padding: const EdgeInsets.only(bottom: 14),
      child: Container(
        padding: const EdgeInsets.fromLTRB(16, 14, 16, 14),
        decoration: BoxDecoration(
          color: look.card,
          borderRadius: BorderRadius.circular(20),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 4,
                  ),
                  decoration: BoxDecoration(
                    color: look.pill,
                    borderRadius: BorderRadius.circular(999),
                  ),
                  child: Text(
                    look.label,
                    style: TextStyle(
                      fontSize: 12,
                      fontWeight: FontWeight.w700,
                      color: look.pillText,
                    ),
                  ),
                ),
                const SizedBox(width: 12),
                if (submitted != null)
                  Expanded(
                    child: Text(
                      sentAgo(submitted, now ?? DateTime.now()),
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.right,
                      style: const TextStyle(fontSize: 12.5, color: _grey),
                    ),
                  ),
              ],
            ),
            const SizedBox(height: 10),
            Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        shift.venue,
                        style: const TextStyle(
                          fontSize: 20,
                          height: 1.15,
                          fontWeight: FontWeight.w700,
                          color: _ink,
                        ),
                      ),
                      const SizedBox(height: 4),
                      Text(
                        displayRoleName(shift.role),
                        style: const TextStyle(fontSize: 14, color: _grey),
                      ),
                    ],
                  ),
                ),
                if (openable) ...[
                  const SizedBox(width: 12),
                  _CircleButton(
                    diameter: 40,
                    background: Colors.white,
                    tooltip: 'View sent shift',
                    onPressed: () => vmPush(
                      context,
                      VenueSentShiftDetail(shiftId: shift.id),
                    ),
                    icon: Icons.north_east,
                    iconColor: _ink,
                  ),
                ],
              ],
            ),
            const SizedBox(height: 10),
            Wrap(
              spacing: 16,
              runSpacing: 6,
              children: [
                _meta(
                  Icons.calendar_today_outlined,
                  sentShiftDate(shift.start),
                ),
                _meta(
                  Icons.schedule,
                  sentShiftTimeRange(shift.start, shift.end),
                ),
              ],
            ),
            const SizedBox(height: 10),
            Divider(height: 1, color: _ink.withValues(alpha: .08)),
            const SizedBox(height: 10),
            Row(
              children: [
                Container(
                  width: 1.5,
                  height: 14,
                  decoration: BoxDecoration(
                    color: _grey,
                    borderRadius: BorderRadius.circular(2),
                  ),
                ),
                const SizedBox(width: 8),
                Expanded(
                  child: Text(
                    sent == 0 ? 'Not sent yet' : 'Sent to $sent staff',
                    style: const TextStyle(fontSize: 13, color: _grey),
                  ),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Widget _meta(IconData icon, String text) => Row(
    mainAxisSize: MainAxisSize.min,
    children: [
      Icon(icon, size: 15, color: _grey),
      const SizedBox(width: 6),
      Text(text, style: const TextStyle(fontSize: 13, color: _ink)),
    ],
  );
}

class VenueSentShiftDetail extends StatelessWidget {
  const VenueSentShiftDetail({super.key, required this.shiftId});
  final String shiftId;
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Sent Shift',
    child: VmData(
      builder: (p) {
        final shift = p.sentShifts.where((s) => s.id == shiftId).firstOrNull;
        final offers = p.offers
            .where((o) => shift != null && o.shiftId == shiftId)
            .toList();
        return ListView(
          padding: const EdgeInsets.all(ScheduleTokens.homeInset),
          children: [
            if (shift != null) ...[
              SentShiftCard(shift: shift, openable: false),
              Padding(
                padding: const EdgeInsets.only(bottom: 16),
                child: Text(shift.label, style: ScheduleTokens.label),
              ),
            ],
            if (shift == null)
              const ScheduleMessageCard(
                title: 'This shift is no longer available.',
                kind: ScheduleMessageKind.error,
              ),
            for (final o in offers)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SchedulePanel(
                  color: Colors.white,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(o.staffName, style: ScheduleTokens.heading),
                      Text(displayRoleName(o.roleName)),
                      Text(offerStatus(o.status), style: ScheduleTokens.label),
                    ],
                  ),
                ),
              ),
          ],
        );
      },
    ),
  );
}

class _SentSkeleton extends StatelessWidget {
  const _SentSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    padding: const EdgeInsets.all(18),
    children: [
      for (var i = 0; i < 3; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 12),
          child: Container(
            height: 126,
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(ScheduleTokens.badgeRadius),
              border: Border.all(color: const Color(0xFFE2E8F0)),
            ),
            padding: const EdgeInsets.all(14),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Container(
                  height: 12,
                  width: 80,
                  color: const Color(0xFFE2E8F0),
                ),
                const SizedBox(height: 10),
                Container(
                  height: 16,
                  width: 180,
                  color: const Color(0xFFF1F5F9),
                ),
                const SizedBox(height: 24),
                Container(
                  height: 10,
                  width: 120,
                  color: const Color(0xFFF1F5F9),
                ),
              ],
            ),
          ),
        ),
    ],
  );
}
