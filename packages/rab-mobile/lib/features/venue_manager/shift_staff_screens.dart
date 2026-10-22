import 'package:flutter/material.dart';
import 'package:provider/provider.dart';

import '../../core/api/api_client.dart';
import '../../core/models/offer.dart';
import '../../core/theme/display_labels.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/shift_pastel_card.dart';
import 'confirmed_staff.dart';
import 'review_staff_report_screen.dart';
import 'sent_shift.dart';
import 'venue_manager_provider.dart';

/// Venue Manager "Sent shift" (one sent request) and "Confirmed staff" (its
/// confirmed seats) screens, plus the small row pieces they share with Event
/// Details. Every value is the server's: the request from
/// `GET /shifts/sent/:id`, the seats from [VenueManagerProvider.loadRoster].

const vmRowBorder = Color(0xFFECEAE5);
const _avatarFill = Color(0xFFEDEBE6);

/// Initials in a light circle (Users, Sent shift, Event Details rows).
class VmInitialsCircle extends StatelessWidget {
  const VmInitialsCircle({super.key, required this.name, this.size = 40});
  final String name;
  final double size;
  static String initials(String name) {
    final parts = name.trim().split(RegExp(r'\s+')).where((p) => p.isNotEmpty);
    final letters = parts.take(2).map((p) => p.characters.first).join();
    return letters.isEmpty ? '?' : letters.toUpperCase();
  }

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: const BoxDecoration(
        color: _avatarFill,
        shape: BoxShape.circle,
      ),
      child: Text(
        initials(name),
        textScaler: TextScaler.noScaling,
        style: TextStyle(
          fontSize: size * .33,
          fontWeight: FontWeight.w700,
          color: ScheduleTokens.ink,
        ),
      ),
    ),
  );
}

/// Small status pill. The text always states the status (colour is never
/// the only signal).
class VmPill extends StatelessWidget {
  const VmPill({
    super.key,
    required this.label,
    required this.background,
    required this.foreground,
  });
  final String label;
  final Color background, foreground;

  /// Booking badge for one seat: mint "Confirmed", amber "Attendance
  /// missing" (worker-flagged, awaiting the manager), red "No-show" only once
  /// the manager has confirmed it.
  factory VmPill.booking(ConfirmedStaffMember m, {Key? key}) {
    final confirmedNoShow = m.isNoShow && m.row?.noShowConfirmed == true;
    final (background, foreground) = !m.isNoShow
        ? (ShiftVisualStyle.mint.badgeSurface, ShiftVisualStyle.mint.badgeText)
        : confirmedNoShow
        ? (ScheduleTokens.dangerSoft, ScheduleTokens.errorText)
        : (const Color(0xFFFFE9C7), const Color(0xFF8A4B00));
    return VmPill(
      key: key,
      label: m.bookingLabel,
      background: background,
      foreground: foreground,
    );
  }

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      label,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
      style: ScheduleType.badge.copyWith(fontSize: 12, color: foreground),
    ),
  );
}

/// White staff row: initials, name, role and a trailing badge. When the
/// row is narrow (small phone, large text) the badge moves under the role
/// instead of squeezing the name.
class VmStaffRow extends StatelessWidget {
  const VmStaffRow({
    super.key,
    required this.name,
    this.role,
    this.trailing,
    this.onTap,
    this.onLongPress,
    this.leading,
    this.nameSuffix = const [],
  });
  final String name;
  final String? role;
  final Widget? trailing;
  final VoidCallback? onTap, onLongPress;

  /// Optional control before the avatar (Users selection checkbox).
  final Widget? leading;
  final List<Widget> nameSuffix;

  @override
  Widget build(BuildContext context) => Material(
    color: Colors.white,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(16),
      side: const BorderSide(color: vmRowBorder),
    ),
    clipBehavior: Clip.antiAlias,
    child: InkWell(
      onTap: onTap,
      onLongPress: onLongPress,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 12),
        child: LayoutBuilder(
          builder: (context, box) {
            final stacked =
                trailing != null &&
                box.maxWidth < MediaQuery.textScalerOf(context).scale(270);
            final text = Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  children: [
                    Flexible(
                      child: Text(
                        name,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: ScheduleType.bodyStrong,
                      ),
                    ),
                    ...nameSuffix,
                  ],
                ),
                if (role != null)
                  Text(
                    role!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: ScheduleType.caption,
                  ),
                if (stacked) ...[const SizedBox(height: 6), trailing!],
              ],
            );
            return Row(
              children: [
                if (leading != null) ...[leading!, const SizedBox(width: 12)],
                VmInitialsCircle(name: name),
                const SizedBox(width: 12),
                Expanded(child: text),
                if (!stacked && trailing != null) ...[
                  const SizedBox(width: 8),
                  trailing!,
                ],
              ],
            );
          },
        ),
      ),
    ),
  );
}

/// Section title with an optional right-aligned count; tappable (with a
/// chevron) when [onTap] is given.
class VmSectionHeader extends StatelessWidget {
  const VmSectionHeader({
    super.key,
    required this.title,
    this.count,
    this.onTap,
    this.tooltip,
  });
  final String title;
  final Widget? count;
  final VoidCallback? onTap;
  final String? tooltip;

  @override
  Widget build(BuildContext context) {
    final row = Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: Semantics(
              header: true,
              child: Text(
                title,
                style: ScheduleType.cardTitle.copyWith(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          ?count,
          if (onTap != null) ...[
            const SizedBox(width: 4),
            const Icon(Icons.chevron_right, color: ScheduleTokens.ink),
          ],
        ],
      ),
    );
    if (onTap == null) return row;
    return Semantics(
      button: true,
      label: tooltip,
      child: InkWell(
        borderRadius: BorderRadius.circular(12),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(
            minHeight: ScheduleTokens.touchTarget,
          ),
          child: row,
        ),
      ),
    );
  }
}

Widget _loadingCard() => const Padding(
  padding: EdgeInsets.symmetric(vertical: 24),
  child: Center(child: CircularProgressIndicator()),
);

Widget _errorCard(String message, VoidCallback retry) => ScheduleMessageCard(
  title: 'Unable to load',
  message: message,
  kind: ScheduleMessageKind.error,
  actionLabel: 'Retry',
  onAction: retry,
);

String _rosterError(Object e) => e is StateError
    ? 'This shift\'s staff could not be matched. Please try again.'
    : userMessageFor(e, fallback: 'Unable to load confirmed staff.');

/// Opens the attendance review for one seat (the same screen the shift
/// report uses), then returns whether the caller should reload.
Future<bool> openSeatAttendance(
  BuildContext context,
  ShiftRoster roster,
  ConfirmedStaffMember member,
) async {
  final report = roster.report, row = member.row;
  if (report == null || row == null) return false;
  await Navigator.of(context).push<bool>(
    MaterialPageRoute(
      builder: (_) => ReviewStaffReportScreen(report: report, row: row),
    ),
  );
  return true;
}

/// One sent staffing request: summary card, who it went to, and its
/// confirmed staff. Opened from a Sent Shifts card or from Event Details.
class VenueSentShiftDetail extends StatefulWidget {
  const VenueSentShiftDetail({super.key, required this.shiftId, this.now});
  final String shiftId;

  /// Injectable clock for the relative "Sent …" text in tests (display only).
  final DateTime? now;
  @override
  State<VenueSentShiftDetail> createState() => _VenueSentShiftDetailState();
}

class _VenueSentShiftDetailState extends State<VenueSentShiftDetail> {
  SentShift? shift;
  Object? error;
  ShiftRoster? roster;
  Object? rosterError;
  bool loading = true;
  int _generation = 0;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final stamp = ++_generation;
    final p = context.read<VenueManagerProvider>();
    setState(() {
      loading = true;
      error = null;
      rosterError = null;
    });
    final sentFuture = settle(p.loadSentShift(widget.shiftId));
    final rosterFuture = settle(p.loadRoster(widget.shiftId));
    final (nextShift, shiftError) = await sentFuture;
    if (!mounted || stamp != _generation) return;
    setState(() {
      shift = nextShift;
      error = shiftError;
    });
    final (nextRoster, failure) = await rosterFuture;
    if (!mounted || stamp != _generation) return;
    setState(() {
      roster = nextRoster;
      rosterError = failure;
    });
    if (mounted && stamp == _generation) setState(() => loading = false);
  }

  @override
  Widget build(BuildContext context) {
    final s = shift;
    final err = error;
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(8, 4, 16, 0),
              child: ScheduleNavHeader(
                title: 'Sent shift',
                centerTitle: false,
                backgroundColor: Colors.white,
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _load,
                child: ListView(
                  key: const ValueKey('sent-shift-detail-list'),
                  physics: const AlwaysScrollableScrollPhysics(),
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                  children: [
                    if (s == null && loading)
                      _loadingCard()
                    else if (s == null)
                      err is ApiException && err.statusCode == 404
                          ? const ScheduleMessageCard(
                              title: 'This shift is no longer available.',
                              kind: ScheduleMessageKind.error,
                            )
                          : _errorCard(
                              userMessageFor(
                                err ?? 'unknown',
                                fallback: 'Unable to load this sent shift.',
                              ),
                              _load,
                            )
                    else
                      ..._content(s),
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }

  List<Widget> _content(SentShift s) {
    final sent = s.count('sent');
    final r = roster;
    final p = context.read<VenueManagerProvider>();
    final responses = r == null ? const <(String, String)>[] : _responses(p, r);
    return [
      _SentSummaryCard(shift: s, sent: sent),
      const SizedBox(height: 12),
      Row(
        mainAxisAlignment: MainAxisAlignment.spaceBetween,
        children: [
          Flexible(
            child: Text(
              sent == 0 ? 'Not sent yet' : 'Sent to $sent staff',
              style: ScheduleType.caption,
            ),
          ),
          if (s.submittedAt != null) ...[
            const SizedBox(width: 12),
            Flexible(
              child: Text(
                sentAgo(s.submittedAt!, widget.now ?? DateTime.now()),
                textAlign: TextAlign.right,
                style: ScheduleType.caption,
              ),
            ),
          ],
        ],
      ),
      const SizedBox(height: 18),
      VmSectionHeader(
        key: const ValueKey('sent-confirmed-header'),
        title: 'Confirmed staff',
        count: r == null
            ? null
            : Text(
                '${r.confirmedCount} of ${s.required}',
                style: ScheduleType.caption,
              ),
      ),
      const SizedBox(height: 8),
      if (r == null && loading)
        _loadingCard()
      else if (r == null)
        _errorCard(_rosterError(rosterError ?? 'unknown'), _load)
      else if (r.members.isEmpty)
        const ScheduleMessageCard(title: 'No confirmed staff yet.')
      else
        for (final m in r.members)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: VmStaffRow(
              key: ValueKey('sent-confirmed-row-${m.staffProfileId}'),
              name: m.name,
              role: m.role,
              trailing: VmPill.booking(m),
              onTap: m.row == null
                  ? null
                  : () async {
                      if (await openSeatAttendance(context, r, m) && mounted) {
                        _load();
                      }
                    },
            ),
          ),
      if (responses.isNotEmpty) ...[
        const SizedBox(height: 14),
        VmSectionHeader(
          title: 'Other responses',
          count: Text('${responses.length}', style: ScheduleType.caption),
        ),
        const SizedBox(height: 8),
        for (final (name, label) in responses)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: VmStaffRow(
              name: name,
              role: displayRoleName(s.role),
              trailing: VmPill(
                label: label,
                background: const Color(0xFFF1F0EC),
                foreground: ScheduleTokens.muted,
              ),
            ),
          ),
      ],
    ];
  }

  /// Every recipient of THIS request who is not a confirmed seat, with the
  /// state of their latest offer (server offer status, display label only).
  List<(String, String)> _responses(VenueManagerProvider p, ShiftRoster r) {
    final seated = {for (final m in r.members) m.staffProfileId};
    final latest = <String, OfferSummary>{};
    for (final o in p.offers.where((o) => o.shiftId == widget.shiftId)) {
      final prev = latest[o.staffProfileId];
      if (prev == null || o.sentAt.isAfter(prev.sentAt)) {
        latest[o.staffProfileId] = o;
      }
    }
    final rows = <(String, String)>[];
    for (final o in latest.values) {
      if (seated.contains(o.staffProfileId)) continue;
      rows.add((
        o.staffName,
        // A confirmed offer with no confirmed seat in the report: the booking
        // was later cancelled. Never shown as "Confirmed".
        o.status == 'manager_confirmed' && r.hasAttendance
            ? 'No longer booked'
            : _offerLabel(o.status),
      ));
    }
    rows.sort((a, b) => a.$1.compareTo(b.$1));
    return rows;
  }
}

String _offerLabel(String status) => switch (status) {
  'pending' => 'Pending',
  'staff_accepted' => 'Accepted',
  'manager_confirmed' => 'Confirmed',
  'declined' => 'Declined',
  'expired' => 'Expired',
  'withdrawn' => 'Withdrawn',
  'manager_rejected' => 'Rejected',
  _ => status.replaceAll('_', ' '),
};

class _SentSummaryCard extends StatelessWidget {
  const _SentSummaryCard({required this.shift, required this.sent});
  final SentShift shift;
  final int sent;
  @override
  Widget build(BuildContext context) {
    final style = ShiftVisualStyle.forShift(shift.id);
    final look = sentShiftLook(shift);
    return Container(
      key: const ValueKey('sent-shift-summary'),
      padding: const EdgeInsets.fromLTRB(16, 14, 16, 16),
      decoration: BoxDecoration(
        color: style.card,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: style.cardBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                width: 36,
                height: 36,
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: const Icon(
                  Icons.storefront_outlined,
                  size: 20,
                  color: ScheduleTokens.ink,
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Align(
                  alignment: Alignment.topRight,
                  child: VmPill(
                    key: const ValueKey('sent-shift-status'),
                    label: look.label,
                    background: look.pill,
                    foreground: look.pillText,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            shift.venue,
            style: ScheduleType.cardTitle.copyWith(fontSize: 19),
          ),
          const SizedBox(height: 2),
          Text(displayRoleName(shift.role), style: ScheduleType.secondary),
          const SizedBox(height: 12),
          Wrap(
            spacing: 20,
            runSpacing: 6,
            children: [
              ShiftMetaItem(
                icon: Icons.calendar_today_outlined,
                label: sentShiftDate(shift.start),
              ),
              ShiftMetaItem(
                icon: Icons.schedule,
                label: sentShiftTimeRange(shift.start, shift.end),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Divider(height: 1, color: style.divider),
          const SizedBox(height: 10),
          ShiftCardFooterLine(
            text: sent == 0 ? 'Not sent yet' : 'Sent to $sent staff',
          ),
        ],
      ),
    );
  }
}
