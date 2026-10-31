import '../../core/theme/money.dart';
import '../../core/widgets/schedule_calendar.dart';
import '../../core/widgets/schedule_record_card.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'venue_staff_directory.dart';
export 'venue_staff_directory.dart'
    show VenueUsersScreen, VenueSelectStaffScreen;
export 'venue_staff_profile.dart' show VenueStaffProfileScreen;
import 'send_shift_screen.dart';
import 'sent_shifts_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/api/api_client.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/polling/stale_refresh_notice.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/widgets/schedule_home_components.dart';
import '../../navigation/moving_tab_bar.dart';
import '../home/widgets/upcoming_shift_deck.dart';
import '../home/widgets/shift_routes.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import '../profile/profile_screen.dart';
import '../../core/widgets/schedule_nav_header.dart';
import '../../core/widgets/shift_pastel_card.dart';
import '../../core/widgets/venue_photo.dart';
import 'confirmed_staff.dart';
import 'report_lists.dart';
import 'sent_shift.dart';
import 'shift_staff_screens.dart';
import 'staff_qr_screen.dart';
import 'venue_manager_provider.dart';
import 'venue_teams_screen.dart';

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

class _WorkflowObserver extends NavigatorObserver {
  _WorkflowObserver(this.changed);
  final void Function(bool) changed;
  final List<Route<dynamic>> routes = [];
  void report() => changed(routes.length > 1);
  @override
  void didPush(Route<dynamic> route, Route<dynamic>? previousRoute) {
    routes.add(route);
    report();
  }

  @override
  void didPop(Route<dynamic> route, Route<dynamic>? previousRoute) {
    routes.remove(route);
    report();
  }

  @override
  void didRemove(Route<dynamic> route, Route<dynamic>? previousRoute) {
    routes.remove(route);
    report();
  }

  @override
  void didReplace({Route<dynamic>? newRoute, Route<dynamic>? oldRoute}) {
    final index = routes.indexOf(oldRoute!);
    if (index >= 0 && newRoute != null) routes[index] = newRoute;
    report();
  }
}

class VenueManagerShell extends StatefulWidget {
  const VenueManagerShell({super.key});
  @override
  State<VenueManagerShell> createState() => _VenueManagerShellState();
}

class _VenueManagerShellState extends State<VenueManagerShell>
    with WidgetsBindingObserver {
  int _tab = 0;
  final _workflow = List.filled(4, false);
  late final _observers = List.generate(
    4,
    (i) => _WorkflowObserver((nested) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _workflow[i] != nested) {
          setState(() => _workflow[i] = nested);
        }
      });
    }),
  );
  final _navigators = List.generate(4, (_) => GlobalKey<NavigatorState>());
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<VenueManagerProvider>().refresh();
    });
  }

  /// The full refresh on resume runs only after the app was really in the
  /// background (hidden/paused), not after a notification shade or a system
  /// dialog (`inactive` only) — it reads every list.
  bool _wasBackgrounded = false;

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.hidden ||
        state == AppLifecycleState.paused) {
      _wasBackgrounded = true;
    } else if (state == AppLifecycleState.resumed && _wasBackgrounded) {
      _wasBackgrounded = false;
      context.read<VenueManagerProvider>().refresh(silent: true);
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
            // A hidden tab keeps its state but not its tickers: TickerMode
            // off is how a screen's poller knows it is not visible (the
            // IndexedStack alone keeps TickerMode on for every child).
            (i) => TickerMode(
              enabled: i == _tab,
              child: NavigatorPopHandler(
                enabled: i == _tab,
                onPopWithResult: (_) {
                  // A cancelled system pop notifies every registered PopScope,
                  // including handlers belonging to inactive IndexedStack tabs.
                  final navigator = _navigators[i].currentState;
                  if (i == _tab && navigator != null && navigator.canPop()) {
                    navigator.pop();
                  }
                },
                child: Navigator(
                  key: _navigators[i],
                  observers: [_observers[i]],
                  onGenerateRoute: (_) => MaterialPageRoute<void>(
                    builder: (_) => switch (i) {
                      0 => VenueManagerHome(
                        onProfile: () => setState(() => _tab = 3),
                      ),
                      1 => VenueCalendarScreen(
                        onProfile: () => setState(() => _tab = 3),
                      ),
                      2 => const VenueHistoryScreen(),
                      _ => const ProfileScreen(),
                    },
                  ),
                ),
              ),
            ),
          ),
        ),
        bottomNavigationBar: _workflow[_tab]
            ? null
            : MovingTabBar(
                index: _tab,
                scheduleStyle: true,
                tabLabels: const ['Home', 'Calendar', 'History', 'Profile'],
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
            else ...[
              if (p.refreshFailed) const StaleRefreshNotice(),
              if (_mySpace) ..._personal(p) else ..._organization(p),
            ],
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
                // Fixed card colour (owner request 2026-10-18), whatever the shift's own colour is.
                color: const Color(0xFFF8ECE1),
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
        const ScheduleMessageCard(
          title: 'No upcoming events in your assigned venues.',
        ),
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
      () => showScheduleSheet<void>(
        context: context,
        builder: (_) => const Text(
          'Manage staffing for your assigned venues. Review events, staff and offers from My Space. Staff acceptance waits for Manager confirmation. Offer sending is available only where your account has permission and owns the shift.',
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
            padding: const EdgeInsets.all(ScheduleTokens.homeInset),
            children: [
              for (final v in p.venues)
                _row(
                  v['name'] as String,
                  null,
                  Icons.storefront_outlined,
                  null,
                ),
              if (p.venues.isEmpty)
                const ScheduleMessageCard(title: 'No venues assigned.'),
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
          // Distinct submitted staffing requests (server `counts.submitted`: one per request, however many staff it
          // reached, expired ones included — i.e. Sent Shifts' All + Expired). Never recipient-level offers.
          _overview(
            'Staffing requests',
            p.sentSubmitted,
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
            'Confirmed events',
            p.confirmedEvents.length,
            Icons.event_available_outlined,
            const VenueConfirmedEventsScreen(),
          ),
          _overview(
            'Upcoming Events',
            p.upcoming.length,
            Icons.schedule_outlined,
            const VenueEventsScreen(),
          ),
          if (p.allows('report.view')) ...[
            // Server counts (five-hour policy): current reports vs History — the same lists those screens show.
            _overview(
              'Reports',
              p.currentReportCount,
              Icons.description_outlined,
              const VenueReportsScreen(),
            ),
            _overview(
              'History',
              p.historyReportCount,
              Icons.history,
              const VenueHistoryScreen(),
            ),
          ],
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

Widget _row(String title, int? count, IconData icon, VoidCallback? onTap) =>
    Padding(
      padding: const EdgeInsets.only(bottom: 10),
      child: Material(
        color: Colors.white,
        borderRadius: BorderRadius.circular(ScheduleTokens.rowRadius),
        child: ListTile(
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(ScheduleTokens.rowRadius),
          ),
          leading: Icon(icon, size: 20),
          title: Text(title, style: ScheduleTokens.body),
          trailing: count == null
              ? (onTap == null
                    ? null
                    : const Icon(Icons.chevron_right, size: 18))
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
      padding: const EdgeInsets.all(ScheduleTokens.homeInset),
      child: ScheduleMessageCard(
        title: 'Unable to load',
        message: message,
        kind: ScheduleMessageKind.error,
        actionLabel: 'Retry',
        onAction: retry,
      ),
    ),
  );
}

class VmData extends StatelessWidget {
  const VmData({
    super.key,
    required this.builder,
    this.keepContentWhileRefreshing = false,
  });
  final bool keepContentWhileRefreshing;
  final Widget Function(VenueManagerProvider) builder;
  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    if (p.loading && !(keepContentWhileRefreshing && p.updatedAt != null)) {
      return const Center(child: CircularProgressIndicator());
    }
    if (p.error != null) return VmError(message: p.error!, retry: p.refresh);
    // Data stays on screen after a failed refresh, with a non-blocking notice.
    // Fixed slots, so showing the notice never rebuilds the page's state.
    return Column(
      children: [
        if (p.refreshFailed)
          const Padding(
            padding: EdgeInsets.symmetric(horizontal: 18),
            child: StaleRefreshNotice(),
          )
        else
          const SizedBox.shrink(),
        Expanded(child: builder(p)),
      ],
    );
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
    return ScheduleRecordCard(
      title: event.role,
      openLabel: 'Open event',
      venue: event.venue,
      address: event.address,
      color: style.card,
      metricLabel: 'Staff joined',
      metricValue: '${event.filled}/${event.required}',
      teamLabel: 'Staff Members',
      names: team.map((m) => m.staffName).toList(),
      onOpen: onOpen,
      opacity: opacity,
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
    padding: const EdgeInsets.all(ScheduleTokens.homeInset),
    physics: const AlwaysScrollableScrollPhysics(),
    children: [
      if (events.isEmpty)
        const ScheduleMessageCard(title: 'No events for this period.'),
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

/// My Space → "Confirmed events": current and upcoming shifts with confirmed
/// staff, on the shared pastel shift card in each shift's identity colour.
class VenueConfirmedEventsScreen extends StatelessWidget {
  const VenueConfirmedEventsScreen({super.key});

  static String badge(VenueEvent e) => switch (e.status) {
    'in_progress' => 'Live now',
    'partially_filled' => 'Partially filled',
    _ => 'Confirmed',
  };

  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Confirmed events',
    child: VmData(
      builder: (p) {
        final rows = p.confirmedEvents;
        return RefreshIndicator(
          onRefresh: p.refresh,
          child: ListView(
            padding: const EdgeInsets.all(ScheduleTokens.homeInset),
            physics: const AlwaysScrollableScrollPhysics(),
            children: [
              if (rows.isEmpty)
                const ScheduleMessageCard(
                  title: 'No confirmed events',
                  message:
                      'Upcoming shifts with confirmed staff appear here. Finished events move to Reports.',
                ),
              for (final e in rows)
                Padding(
                  key: ValueKey('confirmed-event-${e.id}'),
                  padding: const EdgeInsets.only(bottom: 16),
                  child: ShiftPastelCard(
                    style: p.style(e),
                    badge: badge(e),
                    role: e.role,
                    venue: e.venue,
                    startsAt: e.start,
                    endsAt: e.end,
                    onOpen: () => vmPush(
                      context,
                      VenueEventDetail(event: e, style: p.style(e)),
                    ),
                    footer: ShiftCardFooterLine(
                      text:
                          '${e.filled} / ${e.required} staff confirmed'
                          '${e.vacancies > 0 ? ' · ${e.vacancies} open' : ''}',
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

class VenueOffersScreen extends StatelessWidget {
  const VenueOffersScreen({super.key, this.confirmedOnly = false});
  final bool confirmedOnly;
  @override
  Widget build(BuildContext context) => !confirmedOnly
      ? const VenueSentShiftsScreen()
      : VmPage(
          title: confirmedOnly ? 'Confirmed staff' : 'Staffing requests',
          child: VmData(
            builder: (p) {
              final rows = confirmedOnly ? p.confirmed : p.offers;
              return RefreshIndicator(
                onRefresh: p.refresh,
                child: ListView(
                  padding: const EdgeInsets.all(ScheduleTokens.homeInset),
                  physics: const AlwaysScrollableScrollPhysics(),
                  children: [
                    if (rows.isEmpty)
                      Text(
                        confirmedOnly
                            ? 'No confirmed staff yet.'
                            : 'No offers in your assigned venues.',
                      ),
                    for (final o in rows)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 14),
                        child: SchedulePanel(
                          color: ScheduleTokens.surface,
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

/// Display only: never infers offer confirmation or lifecycle from the clock.
CalendarStatus venueCalendarStatus(VenueEvent event) => switch (event.status) {
  'open' => CalendarStatus.openRequest,
  'partially_filled' => CalendarStatus.partiallyFilled,
  'fully_filled' => CalendarStatus.filled,
  'confirmed' => CalendarStatus.confirmed,
  'offered' => CalendarStatus.offered,
  'pending_manager_approval' => CalendarStatus.awaitingApproval,
  'declined' => CalendarStatus.declined,
  'in_progress' => CalendarStatus.live,
  'completed' => CalendarStatus.complete,
  'cancelled' => CalendarStatus.cancelled,
  'draft' => CalendarStatus.draft,
  _ => CalendarStatus.other,
};

class VenueCalendarScreen extends StatelessWidget {
  const VenueCalendarScreen({super.key, this.onProfile, this.now});
  final VoidCallback? onProfile;
  final DateTime? now;
  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final events = p.events.where((e) => e.status != 'cancelled').toList()
      ..sort((a, b) => a.start.compareTo(b.start));
    return ScheduleCalendar(
      agendaStyle: true,
      now: now,
      emptyTitle: 'No scheduled events',
      recordNoun: 'event',
      legend: events.isEmpty
          ? const [CalendarStatus.confirmed, CalendarStatus.openRequest]
          : ({for (final event in events) venueCalendarStatus(event)}.toList()
              ..sort((a, b) => a.index.compareTo(b.index))),
      onRefresh: p.refresh,
      loading: p.loading,
      error: p.error,
      onRetry: p.refresh,
      onProfile: onProfile,
      entries: [
        for (var i = 0; i < events.length; i++)
          ScheduleCalendarEntry(
            id: events[i].id,
            start: events[i].start,
            end: events[i].end,
            status: venueCalendarStatus(events[i]),
            builder: (context) => ScheduleRecordCard(
              title: events[i].role,
              venue: events[i].venue,
              address: events[i].address,
              color: i.isEven
                  ? const Color(0xFFE7F4EE)
                  : const Color(0xFFFCEADF),
              metricLabel: events[i].json['payRatePence'] is num
                  ? 'Pay rate'
                  : 'Staff joined',
              metricValue: events[i].json['payRatePence'] is num
                  ? '${formatPence((events[i].json['payRatePence'] as num).toInt())}/h'
                  : '${events[i].filled}/${events[i].required}',
              scheduleLabel:
                  '${eventTime(events[i])} \u00b7 ${venueCalendarStatus(events[i]).label}',
              teamLabel: p.team(events[i]).isEmpty
                  ? 'No team assigned'
                  : p.team(events[i]).length == 1
                  ? 'Team Member'
                  : 'Team Members',
              names: p.team(events[i]).map((m) => m.staffName).toList(),
              onOpen: () => Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (_) => VenueEventDetail(
                    event: events[i],
                    style: p.style(events[i]),
                  ),
                ),
              ),
            ),
          ),
      ],
    );
  }
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
  ShiftRoster? roster;
  Object? rosterError;
  bool rosterLoading = true;
  int _generation = 0;
  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    final stamp = ++_generation;
    setState(() {
      event = null;
      error = null;
      rosterError = null;
      rosterLoading = true;
    });
    final p = context.read<VenueManagerProvider>();
    // The roster loads beside the shift; its failure never hides the event.
    final rosterFuture = settle(p.loadRoster(widget.event.id));
    try {
      final json =
          await p.api.get('/shifts/${widget.event.id}') as Map<String, dynamic>;
      if (mounted && stamp == _generation) {
        setState(
          () => event = VenueEvent(
            json,
            role: widget.event.role,
            venue: widget.event.venue,
          ),
        );
      }
    } catch (e) {
      if (mounted && stamp == _generation) {
        setState(
          () => error = userMessageFor(e, fallback: 'Unable to load event.'),
        );
      }
    }
    final (next, failure) = await rosterFuture;
    if (mounted && stamp == _generation) {
      setState(() {
        roster = next;
        rosterError = failure;
        rosterLoading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final e = event;
    final style = widget.style;
    return DecoratedBox(
      decoration: BoxDecoration(gradient: style.detailGradient),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        body: SafeArea(
          child: Column(
            children: [
              const Padding(
                padding: EdgeInsets.fromLTRB(8, 4, 8, 0),
                child: ScheduleNavHeader(title: 'Event Details'),
              ),
              Expanded(
                child: error != null
                    ? VmError(message: error!, retry: _load)
                    : e == null
                    ? const Center(child: CircularProgressIndicator())
                    : RefreshIndicator(
                        onRefresh: _load,
                        child: ListView(
                          key: const ValueKey('event-detail-list'),
                          physics: const AlwaysScrollableScrollPhysics(),
                          padding: const EdgeInsets.fromLTRB(20, 12, 20, 32),
                          children: _content(context, p, e),
                        ),
                      ),
              ),
              if (e != null && error == null && _attendanceActions(p, e))
                ScheduleBottomAction(
                  child: Row(
                    children: [
                      Expanded(
                        child: SchedulePrimaryButton(
                          key: const ValueKey('event-qr-code'),
                          label: 'Qr-Code',
                          light: true,
                          onPressed: () => vmPush(
                            context,
                            VenueStaffQrScreen(shiftId: e.id),
                          ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: SchedulePrimaryButton(
                          key: const ValueKey('event-clock-in-out'),
                          label: 'Clock-In/Out',
                          onPressed: () async {
                            await Navigator.of(context).push(
                              MaterialPageRoute<void>(
                                builder: (_) => VenueTeamsScreen(
                                  event: e,
                                  leaderName: context
                                      .read<AuthProvider?>()
                                      ?.user
                                      ?.fullName,
                                ),
                              ),
                            );
                            // Punches made there change the staffing counts.
                            if (mounted) _load();
                          },
                        ),
                      ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }

  /// Qr-Code and Clock-In/Out both read the shift report (`report.view`);
  /// the on-behalf punches inside are further gated by `attendance.edit`.
  /// Not for cancelled, draft or completed shifts.
  bool _attendanceActions(VenueManagerProvider p, VenueEvent e) =>
      p.allows('report.view') &&
      !const {'cancelled', 'draft', 'completed'}.contains(e.status);

  List<Widget> _content(
    BuildContext context,
    VenueManagerProvider p,
    VenueEvent e,
  ) {
    final style = widget.style;
    final r = roster;
    final report = r?.report;
    final notes = e.notes.trim();
    final status = reportEventLook(e.status);
    final fullyFilled = e.status == 'fully_filled';
    Widget pill(IconData? icon, String label, {Key? key}) => Container(
      key: key,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: style.metadataSurface,
        border: Border.all(color: style.surfaceBorder),
        boxShadow: style.metadataShadows,
        borderRadius: BorderRadius.circular(999),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (icon != null) ...[
            Icon(icon, size: 16, color: ScheduleTokens.ink),
            const SizedBox(width: 6),
          ],
          Flexible(
            child: Text(
              label,
              style: ScheduleType.bodyStrong.copyWith(fontSize: 13),
            ),
          ),
        ],
      ),
    );
    return [
      Center(
        child: Container(
          padding: const EdgeInsets.all(3),
          decoration: BoxDecoration(
            color: Colors.white,
            shape: BoxShape.circle,
            boxShadow: style.iconShadows,
          ),
          child: VenuePhoto(
            fileId: e.json['venuePhotoFileId'] as String?,
            size: 76,
            circle: true,
            iconSize: 30,
            placeholderColor: Colors.white,
            semanticLabel: '${e.venue} photo',
          ),
        ),
      ),
      const SizedBox(height: 16),
      Text(e.role, textAlign: TextAlign.center, style: ScheduleType.pageTitle),
      const SizedBox(height: 4),
      Text(e.venue, textAlign: TextAlign.center, style: ScheduleType.body),
      if (e.address.isNotEmpty)
        Text(
          e.address,
          textAlign: TextAlign.center,
          style: ScheduleType.secondary,
        ),
      const SizedBox(height: 14),
      Wrap(
        alignment: WrapAlignment.center,
        spacing: 8,
        runSpacing: 8,
        children: [
          pill(
            fullyFilled ? Icons.check : null,
            status.label,
            key: const ValueKey('event-status-pill'),
          ),
          pill(null, DateFormat('d MMM yyyy').format(e.start)),
          pill(null, eventTime(e)),
        ],
      ),
      const SizedBox(height: 20),
      Center(
        child: Container(
          width: 150,
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
          decoration: BoxDecoration(
            // Lighter than the page: the strong top of the gradient would
            // swallow `noteChip` this high on the screen.
            color: style.chipSurface,
            borderRadius: const BorderRadius.vertical(top: Radius.circular(14)),
          ),
          child: const Text(
            'NOTE',
            textAlign: TextAlign.center,
            style: ScheduleType.overline,
          ),
        ),
      ),
      Container(
        key: const ValueKey('event-note-panel'),
        width: double.infinity,
        padding: const EdgeInsets.all(18),
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(24),
          boxShadow: style.noteShadows,
        ),
        child: notes.isEmpty
            ? const Row(
                children: [
                  Icon(
                    Icons.notes_outlined,
                    size: 20,
                    color: ScheduleTokens.muted,
                  ),
                  SizedBox(width: 10),
                  Expanded(
                    child: Text(
                      'No details provided',
                      style: ScheduleType.secondary,
                    ),
                  ),
                ],
              )
            : Text(notes, style: ScheduleType.body),
      ),
      const SizedBox(height: 22),
      const VmSectionHeader(title: 'Staffing'),
      const SizedBox(height: 6),
      _StaffingCard(
        values: [
          ('Required', '${e.required}'),
          ('Filled', '${e.filled}'),
          // Counts of staff with a recorded clock-in / clock-out, from the
          // shift report; '—' when the report is unavailable (never 0).
          ('Clock in', report == null ? '—' : '${report.clockedIn}'),
          ('Clock out', report == null ? '—' : '${report.clockedOut}'),
        ],
      ),
      const SizedBox(height: 18),
      VmSectionHeader(
        key: const ValueKey('event-confirmed-header'),
        title: 'Confirmed staff',
        count: r == null
            ? null
            : Container(
                key: const ValueKey('event-confirmed-count'),
                constraints: const BoxConstraints(minWidth: 28),
                padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 3),
                decoration: BoxDecoration(
                  color: Colors.white,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  '${r.confirmedCount}',
                  textAlign: TextAlign.center,
                  style: ScheduleType.badge.copyWith(fontSize: 12),
                ),
              ),
      ),
      const SizedBox(height: 8),
      if (r == null && rosterLoading)
        const Padding(
          padding: EdgeInsets.all(16),
          child: Center(child: CircularProgressIndicator()),
        )
      else if (r == null)
        ScheduleMessageCard(
          title: 'Confirmed staff unavailable',
          message: userMessageFor(
            rosterError ?? 'unknown',
            fallback: 'Unable to load confirmed staff.',
          ),
          kind: ScheduleMessageKind.error,
          actionLabel: 'Retry',
          onAction: _load,
        )
      else if (r.members.isEmpty)
        const ScheduleMessageCard(title: 'No confirmed staff yet.')
      else
        for (final m in r.members)
          Padding(
            padding: const EdgeInsets.only(bottom: 10),
            child: VmStaffRow(
              key: ValueKey('event-staff-row-${m.staffProfileId}'),
              name: m.name,
              role: m.role,
              trailing: m.isNoShow
                  ? VmPill.booking(m)
                  : Container(
                      width: 26,
                      height: 26,
                      decoration: BoxDecoration(
                        color: ShiftVisualStyle.mint.badgeSurface,
                        shape: BoxShape.circle,
                      ),
                      child: Icon(
                        Icons.check,
                        size: 16,
                        color: ShiftVisualStyle.mint.badgeText,
                        semanticLabel: 'Confirmed',
                      ),
                    ),
              onTap: m.row == null
                  ? null
                  : () async {
                      if (await openSeatAttendance(context, r, m) && mounted) {
                        _load();
                      }
                    },
            ),
          ),
      if (p.canSend(e)) ...[
        const SizedBox(height: 16),
        SchedulePrimaryButton(
          label: 'Send offers',
          onPressed: () => vmPush(context, SendShiftScreen(existingEvent: e)),
        ),
      ],
    ];
  }
}

/// Required | Filled ┊ Clock in | Clock out. Two rows of two when the four
/// columns would not fit (small phone or large text).
class _StaffingCard extends StatelessWidget {
  const _StaffingCard({required this.values});
  final List<(String, String)> values;

  @override
  Widget build(BuildContext context) => Container(
    key: const ValueKey('event-staffing-card'),
    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
    decoration: BoxDecoration(
      color: Colors.white,
      borderRadius: BorderRadius.circular(18),
      border: Border.all(color: vmRowBorder),
    ),
    child: LayoutBuilder(
      builder: (context, box) {
        final scaler = MediaQuery.textScalerOf(context);
        Widget cell((String, String) v) => Semantics(
          label: '${v.$1}: ${v.$2 == '—' ? 'unknown' : v.$2}',
          excludeSemantics: true,
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                v.$1,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: ScheduleType.caption.copyWith(fontSize: 12),
              ),
              const SizedBox(height: 6),
              Text(v.$2, style: ScheduleType.cardTitle.copyWith(fontSize: 18)),
            ],
          ),
        );
        Widget pair(List<(String, String)> two) =>
            Row(children: [for (final v in two) Expanded(child: cell(v))]);
        if (box.maxWidth >= scaler.scale(300)) {
          return IntrinsicHeight(
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: pair(values.sublist(0, 2))),
                const VerticalDivider(
                  width: 20,
                  thickness: 1,
                  color: vmRowBorder,
                ),
                Expanded(child: pair(values.sublist(2))),
              ],
            ),
          );
        }
        return Column(
          children: [
            pair(values.sublist(0, 2)),
            const Divider(height: 20, color: vmRowBorder),
            pair(values.sublist(2)),
          ],
        );
      },
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
