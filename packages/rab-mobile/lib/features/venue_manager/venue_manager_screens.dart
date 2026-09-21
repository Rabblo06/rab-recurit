import 'venue_staff_directory.dart';
export 'venue_staff_directory.dart'
    show VenueUsersScreen, VenueAllUsersScreen, VenueSelectStaffScreen;
import 'send_shift_screen.dart';
import 'sent_shifts_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/api/api_client.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_home_components.dart';
import '../../navigation/moving_tab_bar.dart';
import '../home/widgets/upcoming_shift_deck.dart';
import '../home/widgets/shift_routes.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import '../profile/profile_screen.dart';
import 'attendance_correction_sheet.dart';
import 'shift_report.dart';
import 'venue_manager_provider.dart';

String eventTime(VenueEvent e) =>
    '${DateFormat('HH:mm').format(e.start)} – ${DateFormat('HH:mm').format(e.end)}';
String eventDate(VenueEvent e) =>
    '${DateFormat('EEE d MMM').format(e.start)} · ${eventTime(e)}';
String initials(String name) => name
    .trim()
    .split(RegExp(r'\s+'))
    .where((s) => s.isNotEmpty)
    .take(2)
    .map((s) => s.characters.first)
    .join()
    .toUpperCase();
String offerStatus(String status) => switch (status) {
  'pending' => 'Pending',
  'staff_accepted' => 'Waiting for Manager Confirmation',
  'manager_confirmed' => 'Confirmed',
  'declined' => 'Declined',
  'expired' => 'Expired',
  'withdrawn' => 'Withdrawn',
  'manager_rejected' => 'Manager rejected',
  _ => status,
};
void vmPush(BuildContext context, Widget page) =>
    Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => page));

class VenueManagerShell extends StatefulWidget {
  const VenueManagerShell({super.key});
  @override
  State<VenueManagerShell> createState() => _VenueManagerShellState();
}

class _VenueManagerShellState extends State<VenueManagerShell>
    with WidgetsBindingObserver {
  int _tab = 0;
  final _navigators = List.generate(4, (_) => GlobalKey<NavigatorState>());
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<VenueManagerProvider>().refresh();
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      context.read<VenueManagerProvider>().refresh();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Theme(
    data: venueManagerTheme(context),
    child: AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: ScheduleTokens.homeBackground,
        body: IndexedStack(
          index: _tab,
          children: List.generate(
            4,
            (i) => NavigatorPopHandler(
              enabled: i == _tab,
              onPopWithResult: (_) => _navigators[i].currentState!.pop(),
              child: Navigator(
                key: _navigators[i],
                onGenerateRoute: (_) => MaterialPageRoute<void>(
                  builder: (_) => switch (i) {
                    0 => VenueManagerHome(
                      onProfile: () => setState(() => _tab = 3),
                    ),
                    1 => const VenueCalendarScreen(),
                    2 => const VenueOffersScreen(),
                    _ => const ProfileScreen(),
                  },
                ),
              ),
            ),
          ),
        ),
        bottomNavigationBar: MovingTabBar(
          index: _tab,
          scheduleStyle: true,
          tabLabels: const ['Home', 'Calendar', 'Offers', 'Profile'],
          onSelected: (i) {
            if (i == _tab) {
              _navigators[i].currentState!.popUntil((r) => r.isFirst);
            } else {
              setState(() => _tab = i);
            }
          },
        ),
      ),
    ),
  );
}

class VenueManagerHome extends StatefulWidget {
  const VenueManagerHome({super.key, required this.onProfile});
  final VoidCallback onProfile;
  @override
  State<VenueManagerHome> createState() => _VenueManagerHomeState();
}

class _VenueManagerHomeState extends State<VenueManagerHome> {
  bool _mySpace = false;
  @override
  Widget build(BuildContext context) {
    final user = context.watch<AuthProvider>().user!;
    final p = context.watch<VenueManagerProvider>();
    final hour = DateTime.now().hour;
    return SafeArea(
      bottom: false,
      child: RefreshIndicator(
        onRefresh: p.refresh,
        child: ListView(
          physics: const AlwaysScrollableScrollPhysics(),
          padding: const EdgeInsets.fromLTRB(24, 16, 24, 24),
          children: [
            ScheduleHeader(
              first: user.firstName,
              greeting: hour < 12
                  ? 'morning'
                  : hour < 18
                  ? 'afternoon'
                  : 'evening',
              initials: initials(user.fullName),
              unread: context.watch<NotificationsProvider>().unreadCount,
              onNotifications: () =>
                  vmPush(context, const NotificationsScreen()),
              onProfile: widget.onProfile,
            ),
            const SizedBox(height: 16),
            ScheduleSpaceSelector(
              mySpace: _mySpace,
              onChanged: (v) => setState(() => _mySpace = v),
            ),
            const SizedBox(height: 20),
            if (p.loading)
              const Padding(
                padding: EdgeInsets.all(48),
                child: Center(child: CircularProgressIndicator()),
              )
            else if (p.error != null)
              VmError(message: p.error!, retry: p.refresh)
            else if (_mySpace)
              ..._personal(p)
            else
              ..._organization(p),
          ],
        ),
      ),
    );
  }

  List<Widget> _organization(VenueManagerProvider p) {
    final next = p.upcoming.firstOrNull;
    final today =
        next != null && DateUtils.isSameDay(next.start, DateTime.now());
    final needed = p.upcoming.fold<int>(0, (sum, e) => sum + e.vacancies);
    return [
      const Text('Event Details', style: ScheduleTokens.heading),
      Text(
        'Updated at ${DateFormat('h:mm a').format(p.updatedAt!)}',
        style: ScheduleTokens.label,
      ),
      const SizedBox(height: 16),
      IntrinsicHeight(
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Expanded(
              flex: 6,
              child: SchedulePanel(
                color: ScheduleTokens.homePeach,
                onTap: next == null ? null : () => _detail(next, p.style(next)),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      today ? "Today's Event" : 'Next Event',
                      style: ScheduleTokens.label,
                    ),
                    const Divider(),
                    const SizedBox(height: 6),
                    Text(
                      next?.role ?? 'No upcoming events',
                      style: ScheduleTokens.body.copyWith(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 14),
                    if (next != null) ...[
                      Text(
                        next.venue,
                        style: ScheduleTokens.body.copyWith(
                          fontWeight: FontWeight.w600,
                        ),
                      ),
                      if (next.address.isNotEmpty)
                        Text(next.address, style: ScheduleTokens.label),
                      const SizedBox(height: 20),
                      Text(
                        'Staff joined: ${next.filled} / ${next.required}',
                        style: ScheduleTokens.label,
                      ),
                      const SizedBox(height: 20),
                      Text(eventTime(next), style: ScheduleTokens.body),
                      if (!today)
                        Text(
                          DateFormat('d MMM').format(next.start),
                          style: ScheduleTokens.label,
                        ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: 12),
            Expanded(
              flex: 5,
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  SchedulePanel(
                    color: ScheduleTokens.homeMint,
                    onTap: () => vmPush(context, const VenueEventsScreen()),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text(
                          'Open positions',
                          style: ScheduleTokens.label,
                        ),
                        const SizedBox(height: 16),
                        Text(
                          '$needed staff needed',
                          style: ScheduleTokens.heading,
                        ),
                        const SizedBox(height: 12),
                        Text(
                          '${p.venues.length} assigned ${p.venues.length == 1 ? 'venue' : 'venues'}',
                          style: ScheduleTokens.label,
                        ),
                      ],
                    ),
                  ),
                  if (p.allows('report.view')) ...[
                    const SizedBox(height: 12),
                    SchedulePanel(
                      color: ScheduleTokens.lavender,
                      onTap: () => vmPush(context, const VenueReportsScreen()),
                      child: const Center(
                        child: Padding(
                          padding: EdgeInsets.symmetric(vertical: 4),
                          child: Text('Report', style: ScheduleTokens.body),
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
      const SizedBox(height: 24),
      if (p.upcoming.isEmpty) ...[
        const Text('Upcoming Event', style: ScheduleTokens.heading),
        const SizedBox(height: 16),
        const Text('No upcoming events in your assigned venues.'),
      ] else
        UpcomingShiftDeck(
          offers: p.upcoming,
          schedule: true,
          title: 'Upcoming Event',
          cardHeight:
              180 +
              (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(0, 32) *
                  8,
          cardBuilder: (record, style, opacity, onOpen) => VenueEventCard(
            event: record as VenueEvent,
            style: p.style(record),
            opacity: opacity,
            onOpen: onOpen,
          ),
          routeBuilder: (record, rect, style, all) => all
              ? MaterialPageRoute<void>(
                  builder: (_) => const VenueEventsScreen(),
                )
              : venueDetailRoute(
                  context,
                  record as VenueEvent,
                  rect,
                  p.style(record),
                ),
        ),
    ];
  }

  void _detail(VenueEvent e, ShiftVisualStyle style) =>
      vmPush(context, VenueEventDetail(event: e, style: style));
  List<Widget> _personal(VenueManagerProvider p) => [
    const Text('First steps', style: ScheduleTokens.heading),
    const SizedBox(height: 12),
    _row(
      'Discover the app',
      null,
      Icons.play_circle_outline,
      () => showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (_) => const SafeArea(
          child: Padding(
            padding: EdgeInsets.all(24),
            child: Text(
              'Manage staffing for your assigned venues. Review events, staff and offers from My Space. Staff acceptance waits for Manager confirmation. Offer sending is available only where your account has permission and owns the shift.',
            ),
          ),
        ),
      ),
    ),
    _row(
      'My venues',
      p.venues.length,
      Icons.storefront_outlined,
      () => vmPush(
        context,
        VmPage(
          title: 'My venues',
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              for (final v in p.venues)
                _row(
                  v['name'] as String,
                  null,
                  Icons.storefront_outlined,
                  null,
                ),
              if (p.venues.isEmpty) const Text('No venues assigned.'),
            ],
          ),
        ),
      ),
    ),
    const SizedBox(height: 20),
    const Text('Overview', style: ScheduleTokens.heading),
    const SizedBox(height: 12),
    Container(
      decoration: ScheduleTokens.panel(Colors.white),
      child: Column(
        children: [
          _overview(
            'Sent offers',
            p.offers.length,
            Icons.calendar_today_outlined,
            const VenueOffersScreen(),
          ),
          if (p.allows('staff.view'))
            _overview(
              'Users',
              p.userCount,
              Icons.people_outline,
              const VenueUsersScreen(),
            ),
          _overview(
            'Confirmed staff',
            p.confirmedPeople,
            Icons.event_available_outlined,
            const VenueOffersScreen(confirmedOnly: true),
          ),
          _overview(
            'Upcoming Events',
            p.upcoming.length,
            Icons.schedule_outlined,
            const VenueEventsScreen(),
          ),
          if (p.allows('report.view'))
            _overview(
              'Reports',
              p.events.length,
              Icons.description_outlined,
              const VenueReportsScreen(),
            ),
        ],
      ),
    ),
    if (p.directoryError != null)
      Padding(
        padding: const EdgeInsets.only(top: 12),
        child: Text(
          'Users count unavailable. Open Users to retry.',
          style: ScheduleTokens.label,
        ),
      ),
  ];
  Widget _overview(String title, int? count, IconData icon, Widget page) =>
      ListTile(
        leading: Icon(icon, size: 20),
        title: Text(title, style: ScheduleTokens.body),
        trailing: Text(count?.toString() ?? '—'),
        onTap: () => vmPush(context, page),
      );
}

Widget _row(
  String title,
  int? count,
  IconData icon,
  VoidCallback? onTap,
) => Padding(
  padding: const EdgeInsets.only(bottom: 10),
  child: Material(
    color: Colors.white,
    borderRadius: BorderRadius.circular(20),
    child: ListTile(
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20)),
      leading: Icon(icon, size: 20),
      title: Text(title, style: ScheduleTokens.body),
      trailing: count == null
          ? (onTap == null ? null : const Icon(Icons.chevron_right, size: 18))
          : Text('$count'),
      onTap: onTap,
    ),
  ),
);

class VmPage extends StatelessWidget {
  const VmPage({
    super.key,
    required this.title,
    required this.child,
    this.actions,
  });
  final String title;
  final Widget child;
  final List<Widget>? actions;
  @override
  Widget build(BuildContext context) => Scaffold(
    backgroundColor: ScheduleTokens.homeBackground,
    appBar: AppBar(
      backgroundColor: ScheduleTokens.homeBackground,
      foregroundColor: ScheduleTokens.ink,
      title: Text(title),
      actions: actions,
    ),
    body: child,
  );
}

class VmError extends StatelessWidget {
  const VmError({super.key, required this.message, required this.retry});
  final String message;
  final VoidCallback retry;
  @override
  Widget build(BuildContext context) => Center(
    child: Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(message),
          TextButton(onPressed: retry, child: const Text('Retry')),
        ],
      ),
    ),
  );
}

class VmData extends StatelessWidget {
  const VmData({super.key, required this.builder});
  final Widget Function(VenueManagerProvider) builder;
  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    if (p.loading) return const Center(child: CircularProgressIndicator());
    if (p.error != null) return VmError(message: p.error!, retry: p.refresh);
    return builder(p);
  }
}

class VenueEventCard extends StatelessWidget {
  const VenueEventCard({
    super.key,
    required this.event,
    required this.style,
    this.opacity = 1,
    this.onOpen,
  });
  final VenueEvent event;
  final ShiftVisualStyle style;
  final double opacity;
  final VoidCallback? onOpen;
  @override
  Widget build(BuildContext context) {
    final team = context.watch<VenueManagerProvider>().team(event);
    return Material(
      color: style.card,
      borderRadius: BorderRadius.circular(28),
      child: InkWell(
        borderRadius: BorderRadius.circular(28),
        onTap: onOpen,
        child: Padding(
          padding: const EdgeInsets.all(16),
          child: Opacity(
            opacity: opacity,
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: [
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        event.role,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: ScheduleTokens.heading,
                      ),
                    ),
                    IconButton(
                      onPressed: onOpen,
                      tooltip: 'Open event',
                      icon: const CircleAvatar(
                        radius: 15,
                        backgroundColor: Colors.white,
                        child: Icon(
                          Icons.north_east,
                          size: 18,
                          color: ScheduleTokens.ink,
                        ),
                      ),
                    ),
                  ],
                ),
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Expanded(
                      flex: 3,
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            event.venue,
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: ScheduleTokens.body.copyWith(
                              fontWeight: FontWeight.w600,
                            ),
                          ),
                          if (event.address.isNotEmpty)
                            Text(
                              event.address,
                              maxLines: 2,
                              overflow: TextOverflow.ellipsis,
                              style: ScheduleTokens.label,
                            ),
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const Text(
                            'Staff joined',
                            style: ScheduleTokens.label,
                          ),
                          Text(
                            '${event.filled}/${event.required}',
                            style: ScheduleTokens.body,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                Row(
                  children: [
                    const Expanded(
                      child: Text('Staff Members', style: ScheduleTokens.label),
                    ),
                    for (final member in team.take(3))
                      Align(
                        widthFactor: .8,
                        child: CircleAvatar(
                          radius: 12,
                          backgroundColor: Colors.white,
                          child: Text(
                            initials(member.staffName),
                            style: const TextStyle(fontSize: 9),
                          ),
                        ),
                      ),
                    if (team.length > 3)
                      CircleAvatar(
                        radius: 12,
                        backgroundColor: Colors.white,
                        child: Text(
                          '+${team.length - 3}',
                          style: const TextStyle(fontSize: 9),
                        ),
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

Route<void> venueDetailRoute(
  BuildContext context,
  VenueEvent e,
  Rect source,
  ShiftVisualStyle style,
) => pastelDetailRoute(
  source: source,
  style: style,
  reduced: ShiftMotion.reduced(context),
  name: '/venue-event/${e.id}',
  page: VenueEventDetail(event: e, style: style),
  sourceCard: VenueEventCard(event: e, style: style),
);

class VenueEventsScreen extends StatelessWidget {
  const VenueEventsScreen({super.key});
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Upcoming Events',
    child: VmData(builder: (p) => _eventList(context, p.upcoming, p)),
  );
}

Widget _eventList(
  BuildContext context,
  List<VenueEvent> events,
  VenueManagerProvider p,
) => RefreshIndicator(
  onRefresh: p.refresh,
  child: ListView(
    padding: const EdgeInsets.all(24),
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      if (events.isEmpty) const Text('No events for this period.'),
      for (final e in events)
        Padding(
          padding: const EdgeInsets.only(bottom: 16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(eventDate(e), style: ScheduleTokens.label),
              const SizedBox(height: 8),
              Builder(
                builder: (cardContext) => SizedBox(
                  height:
                      180 +
                      (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(
                            0,
                            32,
                          ) *
                          8,
                  child: VenueEventCard(
                    event: e,
                    style: p.style(e),
                    onOpen: () {
                      final box = cardContext.findRenderObject() as RenderBox;
                      Navigator.of(context).push(
                        venueDetailRoute(
                          context,
                          e,
                          box.localToGlobal(Offset.zero) & box.size,
                          p.style(e),
                        ),
                      );
                    },
                  ),
                ),
              ),
            ],
          ),
        ),
    ],
  ),
);

class VenueOffersScreen extends StatelessWidget {
  const VenueOffersScreen({super.key, this.confirmedOnly = false});
  final bool confirmedOnly;
  @override
  Widget build(BuildContext context) => !confirmedOnly
      ? const VenueSentShiftsScreen()
      : VmPage(
          title: confirmedOnly ? 'Confirmed staff' : 'Sent offers',
          child: VmData(
            builder: (p) {
              final rows = confirmedOnly ? p.confirmed : p.offers;
              return RefreshIndicator(
                onRefresh: p.refresh,
                child: ListView(
                  padding: const EdgeInsets.all(24),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    if (rows.isEmpty)
                      Text(
                        confirmedOnly
                            ? 'No confirmed staff yet.'
                            : 'No offers in your assigned venues.',
                      ),
                    for (final (index, o) in rows.indexed)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: SchedulePanel(
                          color: ShiftVisualStyle.forList(index).card,
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                offerStatus(o.status),
                                style: ScheduleTokens.label.copyWith(
                                  color: ScheduleTokens.ink,
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                              const SizedBox(height: 12),
                              Text(o.staffName, style: ScheduleTokens.heading),
                              Text(o.roleName, style: ScheduleTokens.body),
                              Text(o.venueName, style: ScheduleTokens.body),
                              const SizedBox(height: 12),
                              Text(
                                '${DateFormat('d MMM · HH:mm').format(o.startsAt.toLocal())} – ${DateFormat('HH:mm').format(o.endsAt.toLocal())}',
                                style: ScheduleTokens.label,
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              );
            },
          ),
        );
}

class VenueCalendarScreen extends StatefulWidget {
  const VenueCalendarScreen({super.key});
  @override
  State<VenueCalendarScreen> createState() => _VenueCalendarScreenState();
}

class _VenueCalendarScreenState extends State<VenueCalendarScreen> {
  DateTime selected = DateTime.now();
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Calendar',
    child: VmData(
      builder: (p) => Column(
        children: [
          CalendarDatePicker(
            initialDate: selected,
            firstDate: DateTime(2020),
            lastDate: DateTime(2100),
            onDateChanged: (d) => setState(() => selected = d),
          ),
          Expanded(
            child: _eventList(
              context,
              p.events
                  .where(
                    (e) =>
                        e.start.isBefore(
                          DateTime(
                            selected.year,
                            selected.month,
                            selected.day + 1,
                          ),
                        ) &&
                        e.end.isAfter(
                          DateTime(selected.year, selected.month, selected.day),
                        ) &&
                        e.status != 'cancelled',
                  )
                  .toList(),
              p,
            ),
          ),
        ],
      ),
    ),
  );
}

class VenueEventDetail extends StatefulWidget {
  const VenueEventDetail({super.key, required this.event, required this.style});
  final VenueEvent event;
  final ShiftVisualStyle style;
  @override
  State<VenueEventDetail> createState() => _VenueEventDetailState();
}

class _VenueEventDetailState extends State<VenueEventDetail> {
  VenueEvent? event;
  String? error;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      event = null;
      error = null;
    });
    try {
      final p = context.read<VenueManagerProvider>();
      final json =
          await p.api.get('/shifts/${widget.event.id}') as Map<String, dynamic>;
      if (mounted) {
        setState(
          () => event = VenueEvent(
            json,
            role: widget.event.role,
            venue: widget.event.venue,
          ),
        );
      }
    } catch (e) {
      if (mounted) {
        setState(
          () => error = e is ApiException ? e.message : 'Unable to load event.',
        );
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final e = event;
    return DecoratedBox(
      decoration: BoxDecoration(gradient: widget.style.detailGradient),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        appBar: AppBar(
          backgroundColor: Colors.transparent,
          title: const Text('Event Details'),
          centerTitle: true,
        ),
        body: error != null
            ? VmError(message: error!, retry: _load)
            : e == null
            ? const Center(child: CircularProgressIndicator())
            : ListView(
                padding: const EdgeInsets.all(24),
                children: [
                  const Center(
                    child: CircleAvatar(
                      radius: 40,
                      backgroundColor: Colors.white,
                      child: Icon(Icons.storefront_outlined, size: 32),
                    ),
                  ),
                  const SizedBox(height: 20),
                  Text(
                    e.role,
                    textAlign: TextAlign.center,
                    style: ScheduleTokens.heading.copyWith(fontSize: 26),
                  ),
                  const SizedBox(height: 8),
                  Text(e.venue, textAlign: TextAlign.center),
                  if (e.address.isNotEmpty)
                    Text(e.address, textAlign: TextAlign.center),
                  const SizedBox(height: 16),
                  Wrap(
                    alignment: WrapAlignment.center,
                    spacing: 8,
                    runSpacing: 8,
                    children: [
                      Chip(label: Text(e.status.replaceAll('_', ' '))),
                      Chip(
                        label: Text(DateFormat('d MMM yyyy').format(e.start)),
                      ),
                      Chip(label: Text(eventTime(e))),
                    ],
                  ),
                  const Divider(height: 32),
                  SchedulePanel(
                    color: Colors.white,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        const Text('Staffing', style: ScheduleTokens.heading),
                        const SizedBox(height: 12),
                        Text('Required: ${e.required}'),
                        Text('Confirmed: ${e.filled}'),
                        Text('Open positions: ${e.vacancies}'),
                      ],
                    ),
                  ),
                  const SizedBox(height: 20),
                  const Text('Confirmed staff', style: ScheduleTokens.heading),
                  const SizedBox(height: 12),
                  if (p.team(e).isEmpty) const Text('No confirmed staff yet.'),
                  for (final o in p.team(e))
                    _row(o.staffName, null, Icons.person_outline, null),
                  if (e.notes.trim().isNotEmpty) ...[
                    const SizedBox(height: 24),
                    const Center(
                      child: Text('NOTE', style: ScheduleTokens.heading),
                    ),
                    const SizedBox(height: 8),
                    SchedulePanel(
                      color: Colors.white,
                      child: Text(e.notes, style: ScheduleTokens.body),
                    ),
                  ],
                  const SizedBox(height: 24),
                  if (p.canSend(e))
                    FilledButton(
                      onPressed: () =>
                          vmPush(context, SendShiftScreen(existingEvent: e)),
                      child: const Text('Send offers'),
                    ),
                ],
              ),
      ),
    );
  }
}

class VenueReportsScreen extends StatelessWidget {
  const VenueReportsScreen({super.key});
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Reports',
    child: VmData(
      builder: (p) {
        if (!p.allows('report.view')) {
          return const Center(
            child: Text('Reports are not available for this account.'),
          );
        }
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            const Text(
              'Event staffing summaries',
              style: ScheduleTokens.heading,
            ),
            const SizedBox(height: 8),
            const Text(
              'Confirmed positions and remaining staffing requirements. Tap a shift to view attendance.',
              style: ScheduleTokens.label,
            ),
            const SizedBox(height: 20),
            if (p.events.isEmpty) const Text('No events to report.'),
            for (final e in p.events)
              Padding(
                padding: const EdgeInsets.only(bottom: 14),
                child: InkWell(
                  borderRadius: BorderRadius.circular(24),
                  onTap: () => vmPush(context, ShiftReportDetailScreen(event: e)),
                  child: SchedulePanel(
                    color: p.style(e).card,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(e.role, style: ScheduleTokens.heading),
                        Text(e.venue),
                        Text(eventDate(e), style: ScheduleTokens.label),
                        const SizedBox(height: 12),
                        Text(
                          '${e.filled} / ${e.required} confirmed · ${e.vacancies} open',
                        ),
                        Text('Status: ${e.status.replaceAll('_', ' ')}'),
                      ],
                    ),
                  ),
                ),
              ),
          ],
        );
      },
    ),
  );
}

class ShiftReportDetailScreen extends StatefulWidget {
  const ShiftReportDetailScreen({super.key, required this.event});
  final VenueEvent event;

  @override
  State<ShiftReportDetailScreen> createState() => _ShiftReportDetailScreenState();
}

class _ShiftReportDetailScreenState extends State<ShiftReportDetailScreen> {
  late Future<ShiftReportDetail> _future;
  bool _finalising = false;
  String? _actionError;

  @override
  void initState() {
    super.initState();
    _load();
  }

  void _load() {
    setState(() {
      _future = context.read<VenueManagerProvider>().loadReport(widget.event.shiftId);
      _actionError = null;
    });
  }

  Future<void> _finalise() async {
    setState(() {
      _finalising = true;
      _actionError = null;
    });
    try {
      await context.read<VenueManagerProvider>().finaliseReport(widget.event.shiftId);
      if (mounted) _load();
    } on ApiException catch (e) {
      setState(() => _actionError = e.message);
    } catch (_) {
      setState(() => _actionError = 'Something went wrong. Please try again.');
    } finally {
      if (mounted) setState(() => _finalising = false);
    }
  }

  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Shift report',
    child: FutureBuilder<ShiftReportDetail>(
      future: _future,
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        if (snapshot.hasError) {
          return VmError(
            message: snapshot.error is ApiException
                ? (snapshot.error as ApiException).message
                : 'Could not load this report.',
            retry: _load,
          );
        }
        final report = snapshot.data!;
        return RefreshIndicator(
          onRefresh: () async => _load(),
          child: ListView(
            padding: const EdgeInsets.all(24),
            children: [
              Text(report.venueName, style: ScheduleTokens.heading),
              Text(report.roleName, style: ScheduleTokens.body),
              const SizedBox(height: 4),
              Text(
                '${DateFormat('EEE d MMM').format(report.startsAt.toLocal())} · '
                '${DateFormat('HH:mm').format(report.startsAt.toLocal())}–'
                '${DateFormat('HH:mm').format(report.endsAt.toLocal())}',
                style: ScheduleTokens.label,
              ),
              const SizedBox(height: 8),
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 5),
                decoration: BoxDecoration(
                  color: report.isFinalised ? ScheduleTokens.mint : ScheduleTokens.peach,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  report.isFinalised ? 'Finalised' : 'Awaiting review',
                  style: ScheduleTokens.label.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              const SizedBox(height: 20),
              if (report.staff.isEmpty) const Text('No confirmed staff for this shift.'),
              for (final row in report.staff)
                Padding(
                  padding: const EdgeInsets.only(bottom: 14),
                  child: _StaffReportCard(
                    row: row,
                    shiftDate: report.startsAt.toLocal(),
                    locked: report.isFinalised,
                    onCorrected: _load,
                  ),
                ),
              if (_actionError != null)
                Padding(
                  padding: const EdgeInsets.only(bottom: 12),
                  child: Text(_actionError!, style: const TextStyle(color: ScheduleTokens.danger)),
                ),
              if (report.isFinalised)
                Text(
                  report.finalisedAt == null
                      ? 'This report has been finalised.'
                      : 'Finalised on ${DateFormat('d MMM, HH:mm').format(report.finalisedAt!.toLocal())}. The final timesheet will be emailed shortly.',
                  style: ScheduleTokens.label,
                )
              else
                SizedBox(
                  width: double.infinity,
                  height: 50,
                  child: FilledButton(
                    onPressed: report.canFinalise && !_finalising ? _finalise : null,
                    style: FilledButton.styleFrom(
                      backgroundColor: ScheduleTokens.accent,
                      foregroundColor: Colors.white,
                      shape: const StadiumBorder(),
                    ),
                    child: _finalising
                        ? const SizedBox(
                            width: 18,
                            height: 18,
                            child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white),
                          )
                        : Text(
                            report.canFinalise
                                ? 'Finalise & send'
                                : 'Waiting for everyone to clock out',
                          ),
                  ),
                ),
            ],
          ),
        );
      },
    ),
  );
}

class _StaffReportCard extends StatelessWidget {
  const _StaffReportCard({
    required this.row,
    required this.shiftDate,
    required this.locked,
    required this.onCorrected,
  });
  final ShiftReportStaffRow row;
  final DateTime shiftDate;
  final bool locked;
  final VoidCallback onCorrected;

  Future<void> _correct(BuildContext context) async {
    final saved = await showAttendanceCorrectionSheet(
      context,
      row: row,
      shiftDate: shiftDate,
    );
    if (saved == true) onCorrected();
  }

  @override
  Widget build(BuildContext context) => SchedulePanel(
    color: Colors.white,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          children: [
            Expanded(
              child: Text(row.staffName, style: ScheduleTokens.heading.copyWith(fontSize: 16)),
            ),
            Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
              decoration: BoxDecoration(
                color: ScheduleTokens.lavender,
                borderRadius: BorderRadius.circular(999),
              ),
              child: Text(row.statusLabel, style: ScheduleTokens.label.copyWith(fontSize: 11)),
            ),
          ],
        ),
        const SizedBox(height: 10),
        _reportField('Clock in', row.clockInAt == null ? '—' : DateFormat('HH:mm').format(row.clockInAt!.toLocal())),
        _reportField('Clock out', row.clockOutAt == null ? '—' : DateFormat('HH:mm').format(row.clockOutAt!.toLocal())),
        _reportField('Break', '${row.breakMinutes ?? row.scheduledBreakMinutes} min${row.breakMinutes == null ? ' (scheduled)' : ''}'),
        _reportField('Worked', row.workedMinutes == null ? '—' : '${(row.workedMinutes! / 60).toStringAsFixed(1)}h'),
        if (row.corrected)
          const Padding(
            padding: EdgeInsets.only(top: 4),
            child: Text('Corrected', style: TextStyle(fontSize: 11, color: ScheduleTokens.muted)),
          ),
        if (!locked && row.canCorrect) ...[
          const SizedBox(height: 10),
          Align(
            alignment: Alignment.centerRight,
            child: TextButton(
              onPressed: () => _correct(context),
              child: const Text('Review / Edit'),
            ),
          ),
        ],
      ],
    ),
  );

  Widget _reportField(String label, String value) => Padding(
    padding: const EdgeInsets.only(bottom: 2),
    child: Row(
      children: [
        SizedBox(width: 70, child: Text(label, style: ScheduleTokens.label)),
        Text(value, style: ScheduleTokens.body),
      ],
    ),
  );
}

ThemeData venueManagerTheme(BuildContext context) {
  final base = Theme.of(context);
  return base.copyWith(
    colorScheme: base.colorScheme.copyWith(
      primary: ScheduleTokens.accent,
      onPrimary: Colors.white,
      secondary: ScheduleTokens.lavender,
      surface: ScheduleTokens.homeBackground,
    ),
    appBarTheme: base.appBarTheme.copyWith(
      titleTextStyle: ScheduleTokens.heading.copyWith(
        fontFamily: base.textTheme.titleLarge?.fontFamily ?? 'Roboto',
      ),
    ),
    chipTheme: base.chipTheme.copyWith(
      shape: const StadiumBorder(),
      side: BorderSide.none,
      backgroundColor: Colors.white,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: ScheduleTokens.accent,
        foregroundColor: Colors.white,
        minimumSize: const Size(0, 48),
        shape: const StadiumBorder(),
      ),
    ),
  );
}
