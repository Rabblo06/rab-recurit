import '../../core/widgets/schedule_home_components.dart';
import 'package:flutter/material.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/theme/schedule_tokens.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';
import 'send_shift_screen.dart';

/// Coarse relative time — "just now" / "Xm ago" / "Xh ago" / "Xd ago" /
/// falls back to an absolute short date beyond 6 days. Presentation only,
/// mirrors the web console's own `timeAgo` in spirit; no mobile equivalent
/// existed yet, so this is a small local helper rather than a new shared
/// package dependency.
String _sentAgo(DateTime at) {
  final diff = DateTime.now().difference(at.toLocal());
  if (diff.inMinutes < 1) return 'Sent just now';
  if (diff.inMinutes < 60) return 'Sent ${diff.inMinutes}m ago';
  if (diff.inHours < 24) return 'Sent ${diff.inHours}h ago';
  if (diff.inDays < 7) return 'Sent ${diff.inDays}d ago';
  return 'Sent ${DateFormat('d MMM').format(at.toLocal())}';
}

// Keep human role names; never present a database identifier as a job title.
String _displayRole(String name) {
  final value = name.trim();
  final identifier = RegExp(
    r'^(?:Role-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$',
    caseSensitive: false,
  );
  return value.isEmpty || identifier.hasMatch(value)
      ? 'Role unavailable'
      : value;
}

class VenueSentShiftsScreen extends StatefulWidget {
  const VenueSentShiftsScreen({super.key});
  @override
  State<VenueSentShiftsScreen> createState() => _VenueSentShiftsScreenState();
}

class _VenueSentShiftsScreenState extends State<VenueSentShiftsScreen> {
  String query = '';
  String? status;
  Future<void> create() async {
    await Navigator.of(
      context,
    ).push<String>(MaterialPageRoute(builder: (_) => const SendShiftScreen()));
    if (mounted) context.read<VenueManagerProvider>().refresh();
  }

  Future<void> filters() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            for (final key in <String?>[
              null,
              'pending',
              'staff_accepted',
              'manager_confirmed',
              'declined',
              'expired',
              'withdrawn',
              'manager_rejected',
            ])
              ListTile(
                title: Text(key == null ? 'All offers' : offerStatus(key)),
                trailing: status == key ? const Icon(Icons.check) : null,
                onTap: () {
                  Navigator.pop(sheet);
                  setState(() => status = key);
                },
              ),
          ],
        ),
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
                  'Track shifts sent to staff',
                  style: TextStyle(fontSize: 12, color: Color(0xFF64748B)),
                ),
              ],
            ),
          ),
          const SizedBox(height: 14),
          Expanded(
            child: context.watch<VenueManagerProvider>().loading
                ? const _SentSkeleton()
                : VmData(
                    builder: (p) {
                      final grouped = <String, List<OfferSummary>>{};
                      for (final o in p.offers) {
                        grouped.putIfAbsent(o.shiftId, () => []).add(o);
                      }
                      final groups =
                          grouped.values
                              .where(
                                (group) => group.any(
                                  (o) =>
                                      (status == null || o.status == status) &&
                                      ('${o.venueName} ${o.roleName} ${o.staffName}')
                                          .toLowerCase()
                                          .contains(query.toLowerCase()),
                                ),
                              )
                              .toList()
                            ..sort(
                              (a, b) =>
                                  b.first.sentAt.compareTo(a.first.sentAt),
                            );
                      return RefreshIndicator(
                        onRefresh: p.refresh,
                        child: ListView(
                          padding: const EdgeInsets.fromLTRB(18, 0, 18, 24),
                          physics: const AlwaysScrollableScrollPhysics(),
                          children: [
                            IntrinsicHeight(
                              child: Row(
                                crossAxisAlignment: CrossAxisAlignment.stretch,
                                children: [
                                  for (final (label, count, color, icon) in [
                                    (
                                      'Sent',
                                      p.offers.length,
                                      const Color(0xFFFFF2E8),
                                      Icons.send_rounded,
                                    ),
                                    (
                                      'Accepted',
                                      p.offers
                                          .where(
                                            (o) => o.status == 'staff_accepted',
                                          )
                                          .length,
                                      const Color(0xFFECFDF5),
                                      Icons.check_circle_rounded,
                                    ),
                                    (
                                      'Confirmed',
                                      p.confirmed.length,
                                      const Color(0xFFEEF2FF),
                                      Icons.verified_rounded,
                                    ),
                                  ])
                                    Expanded(
                                      child: Padding(
                                        padding: EdgeInsets.only(
                                          right: label == 'Confirmed' ? 0 : 8,
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
                                      borderRadius: BorderRadius.circular(23),
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
                                        contentPadding: EdgeInsets.symmetric(
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
                                  for (final entry in <String?, String>{
                                    null: 'All',
                                    'pending': 'Pending',
                                    'staff_accepted': 'Accepted',
                                    'manager_confirmed': 'Confirmed',
                                    'declined': 'Declined',
                                  }.entries)
                                    Padding(
                                      padding: const EdgeInsets.only(right: 6),
                                      child: ChoiceChip(
                                        label: Text(
                                          entry.value,
                                          style: TextStyle(
                                            fontSize: 11,
                                            color: status == entry.key
                                                ? Colors.white
                                                : const Color(0xFF0F172A),
                                          ),
                                        ),
                                        selected: status == entry.key,
                                        showCheckmark: false,
                                        selectedColor: const Color(0xFF0F172A),
                                        backgroundColor: Colors.white,
                                        side: BorderSide(
                                          color: status == entry.key
                                              ? const Color(0xFF0F172A)
                                              : const Color(0xFFE7EAF0),
                                        ),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 4,
                                        ),
                                        visualDensity: VisualDensity.compact,
                                        materialTapTargetSize:
                                            MaterialTapTargetSize.shrinkWrap,
                                        onSelected: (_) =>
                                            setState(() => status = entry.key),
                                      ),
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(height: 16),
                            if (groups.isEmpty)
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 24,
                                ),
                                child: Column(
                                  children: [
                                    Text(
                                      p.offers.isEmpty
                                          ? 'No sent shifts yet'
                                          : 'No sent shifts match this view.',
                                      style: ScheduleTokens.body,
                                    ),
                                    if (p.offers.isEmpty) ...[
                                      const SizedBox(height: 8),
                                      const Text(
                                        'Create your first shift offer to get started.',
                                        style: ScheduleTokens.label,
                                      ),
                                      const SizedBox(height: 12),
                                      FilledButton.icon(
                                        onPressed: create,
                                        icon: const Icon(Icons.add, size: 16),
                                        label: const Text('Send Shift'),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            for (final group in groups)
                              _SentCard(offers: group),
                          ],
                        ),
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
      borderRadius: BorderRadius.circular(15),
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

/// Status → the whole card's pastel tint (never just a small chip on white —
/// see this file's own design note above). The status *label* stays legible
/// on top of any of the three tints via a semi-opaque white pill, rather than
/// a second hard-coded color per status.
Color _cardTint(Set<String> statuses) {
  if (statuses.length == 1 && statuses.single == 'manager_confirmed') {
    return const Color(0xFFEEF2FF);
  }
  if (statuses.contains('declined')) return const Color(0xFFFCE8EC);
  if (statuses.contains('staff_accepted')) return const Color(0xFFECFDF5);
  return const Color(0xFFFFF2E8);
}

class _SentCard extends StatelessWidget {
  const _SentCard({required this.offers});
  final List<OfferSummary> offers;
  @override
  Widget build(BuildContext context) {
    final o = offers.first;
    final statuses = offers.map((o) => o.status).toSet();
    final label = statuses.length == 1
        ? offerStatus(statuses.single)
        : 'Mixed responses';
    final tint = _cardTint(statuses);
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Material(
        color: tint,
        borderRadius: BorderRadius.circular(16),
        child: InkWell(
          borderRadius: BorderRadius.circular(16),
          onTap: () =>
              vmPush(context, VenueSentShiftDetail(shiftId: o.shiftId)),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 10, 14, 10),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 3,
                      ),
                      decoration: BoxDecoration(
                        color: Colors.white.withValues(alpha: .55),
                        borderRadius: BorderRadius.circular(8),
                      ),
                      child: Text(
                        label,
                        style: const TextStyle(
                          fontSize: 10.5,
                          fontWeight: FontWeight.w600,
                          color: Color(0xFF0F172A),
                        ),
                      ),
                    ),
                    const Spacer(),
                    Text(
                      _sentAgo(o.sentAt),
                      style: TextStyle(
                        fontSize: 11,
                        color: ScheduleTokens.ink.withValues(alpha: .55),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            // No discrete "event name" field exists on Shift
                            // today — venueName is the closest real,
                            // already-displayed identifier for this slot.
                            o.venueName,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w700,
                              color: Color(0xFF0F172A),
                            ),
                          ),
                          const SizedBox(height: 1),
                          Text(
                            _displayRole(o.roleName),
                            style: TextStyle(
                              fontSize: 12,
                              color: ScheduleTokens.ink.withValues(alpha: .6),
                            ),
                          ),
                        ],
                      ),
                    ),
                    _CircleButton(
                      diameter: 34,
                      background: Colors.white,
                      tooltip: 'View sent shift',
                      onPressed: () => vmPush(
                        context,
                        VenueSentShiftDetail(shiftId: o.shiftId),
                      ),
                      icon: Icons.north_east,
                      iconColor: const Color(0xFF0F172A),
                    ),
                  ],
                ),
                const SizedBox(height: 6),
                Wrap(
                  spacing: 12,
                  runSpacing: 4,
                  children: [
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.calendar_today_outlined,
                          size: 12,
                          color: ScheduleTokens.ink.withValues(alpha: .55),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          DateFormat(
                            'EEE d MMM yyyy',
                          ).format(o.startsAt.toLocal()),
                          style: TextStyle(
                            fontSize: 11.5,
                            color: ScheduleTokens.ink.withValues(alpha: .6),
                          ),
                        ),
                      ],
                    ),
                    Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(
                          Icons.access_time_rounded,
                          size: 12,
                          color: ScheduleTokens.ink.withValues(alpha: .55),
                        ),
                        const SizedBox(width: 5),
                        Text(
                          '${DateFormat('HH:mm').format(o.startsAt.toLocal())}–${DateFormat('HH:mm').format(o.endsAt.toLocal())}',
                          style: TextStyle(
                            fontSize: 11.5,
                            color: ScheduleTokens.ink.withValues(alpha: .6),
                          ),
                        ),
                      ],
                    ),
                  ],
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(vertical: 6),
                  child: Divider(
                    height: 1,
                    color: ScheduleTokens.ink.withValues(alpha: .1),
                  ),
                ),
                Text(
                  'Sent to ${offers.map((o) => o.staffProfileId).toSet().length} staff',
                  style: TextStyle(
                    fontSize: 11.5,
                    color: ScheduleTokens.ink.withValues(alpha: .6),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class VenueSentShiftDetail extends StatelessWidget {
  const VenueSentShiftDetail({super.key, required this.shiftId});
  final String shiftId;
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Sent Shift',
    child: VmData(
      builder: (p) {
        final offers = p.offers.where((o) => o.shiftId == shiftId).toList();
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            if (offers.isEmpty)
              const Text('This shift is no longer available.'),
            for (final o in offers)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: SchedulePanel(
                  color: Colors.white,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(o.staffName, style: ScheduleTokens.heading),
                      Text(_displayRole(o.roleName)),
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
              borderRadius: BorderRadius.circular(16),
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
                const SizedBox(height: 14),
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
