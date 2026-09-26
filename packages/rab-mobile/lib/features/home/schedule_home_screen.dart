import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_home_components.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/auth/auth_provider.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/money.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../navigation/app_shell.dart';
import '../notifications/notifications_provider.dart';
import '../notifications/notifications_screen.dart';
import '../offers/offers_provider.dart';
import '../offers/offers_screen.dart';
import '../offers/schedule_offers_screen.dart';
import '../offers/schedule_offer_detail_screen.dart';
import 'attendance_provider.dart';
import 'schedule_clock_screen.dart';
import 'home_dashboard_data.dart';
import 'widgets/upcoming_shift_deck.dart';
import 'widgets/upcoming_shift_card.dart';
import 'widgets/shift_routes.dart';
import '../../core/models/offer.dart';

/// Schedule is a presentation of the existing authenticated providers.
/// No API clients, data loads or attendance mutations are owned by this view.
class ScheduleHomeScreen extends StatefulWidget {
  const ScheduleHomeScreen({super.key});
  @override
  State<ScheduleHomeScreen> createState() => _ScheduleHomeScreenState();
}

class _ScheduleHomeScreenState extends State<ScheduleHomeScreen> {
  bool _mySpace = false;
  final _dismissed = <String>{};
  final _primaryKey = GlobalKey();
  bool _primaryHidden = false, _openingPrimary = false;

  Widget _primaryPanel(
    OfferSummary? offer, {
    required Color color,
    required Widget child,
    VoidCallback? onTap,
  }) {
    final surface = SchedulePanel(color: color, child: child);
    return SizedBox(
      key: _primaryKey,
      child: Opacity(
        opacity: _primaryHidden ? 0 : 1,
        child: SchedulePanel(
          color: color,
          onTap: onTap == null || offer == null
              ? null
              : () => _openPrimary(offer, surface),
          child: child,
        ),
      ),
    );
  }

  Future<void> _openPrimary(OfferSummary offer, Widget sourceCard) async {
    if (_openingPrimary) return;
    _openingPrimary = true;
    final box = _primaryKey.currentContext!.findRenderObject()! as RenderBox;
    final route =
        pastelDetailRoute(
              source: box.localToGlobal(Offset.zero) & box.size,
              style: ShiftVisualStyle.forShift(offer.shiftId),
              reduced: ShiftMotion.reduced(context),
              name: '/shift/${offer.shiftId}',
              page: ScheduleOfferDetailScreen(offer: offer),
              sourceCard: sourceCard,
              sourceColor: ScheduleTokens.homePeach,
            )
            as TransitionRoute<void>;
    final navigation = Navigator.of(context).push(route);
    void restore(AnimationStatus status) {
      if (mounted && status == AnimationStatus.dismissed) {
        setState(() => _primaryHidden = false);
      }
    }

    route.animation?.addStatusListener(restore);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted && route.animation?.status != AnimationStatus.dismissed) {
        setState(() => _primaryHidden = true);
      }
    });
    try {
      await navigation;
      await route.completed;
    } finally {
      route.animation?.removeStatusListener(restore);
      if (mounted) {
        setState(() {
          _primaryHidden = false;
          _openingPrimary = false;
        });
      }
    }
  }

  void _push(Widget page) =>
      Navigator.of(context).push(MaterialPageRoute(builder: (_) => page));
  void _offers() => _push(const OffersScreen());
  void _schedule() => AppShell.of(context)?.goToTab(1);
  void _explain(String title, String message) => showScheduleSheet<void>(
    context: context,
    builder: (context) => Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(title, style: ScheduleTokens.heading),
        const SizedBox(height: 12),
        Text(message, style: ScheduleTokens.body),
        const SizedBox(height: 16),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Got it'),
        ),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final user = context.watch<AuthProvider>().user;
    final offers = context.watch<OffersProvider>();
    final attendance = context.watch<AttendanceProvider>();
    final unread = context.watch<NotificationsProvider>().unreadCount;
    final data = HomeDashboardData(offers.offers);
    final first = user?.firstName.trim() ?? '';
    final last = user?.lastName.trim() ?? '';
    final initials =
        '${first.isEmpty ? '' : first[0]}${last.isEmpty ? '' : last[0]}'
            .toUpperCase();
    final hour = DateTime.now().hour;
    final greeting = hour < 12
        ? 'morning'
        : hour < 18
        ? 'afternoon'
        : 'evening';
    final loading = offers.isLoading || attendance.isLoadingActive;
    final reduced = ShiftMotion.reduced(context);
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.transparent,
      ),
      child: DecoratedBox(
        key: const ValueKey('schedule-home'),
        decoration: BoxDecoration(
          color: ScheduleTokens.homeBackground,
          border: Border.all(color: ScheduleTokens.edge, width: .5),
        ),
        child: SafeArea(
          bottom: false,
          child: RefreshIndicator(
            color: ScheduleTokens.accent,
            onRefresh: () => Future.wait([
              offers.refresh(),
              attendance.refreshActive(),
              attendance.loadHistory(),
            ]),
            child: ListView(
              key: const PageStorageKey('schedule-home-scroll'),
              padding: EdgeInsets.fromLTRB(
                ScheduleTokens.homeInset,
                16,
                ScheduleTokens.homeInset,
                MediaQuery.viewPaddingOf(context).bottom + 92,
              ),
              children: [
                ScheduleHeader(
                  first: first,
                  greeting: greeting,
                  initials: initials,
                  unread: unread,
                  onNotifications: () => _push(const NotificationsScreen()),
                  onProfile: () => AppShell.of(context)?.goToTab(3),
                ),
                const SizedBox(height: 16),
                ScheduleSpaceSelector(
                  mySpace: _mySpace,
                  onChanged: (value) => setState(() => _mySpace = value),
                ),
                const SizedBox(height: ScheduleTokens.homeSectionGap),
                AnimatedSwitcher(
                  duration: reduced
                      ? Duration.zero
                      : ScheduleTokens.styleMotion,
                  switchInCurve: Curves.easeOutCubic,
                  switchOutCurve: Curves.easeInCubic,
                  transitionBuilder: (child, animation) => FadeTransition(
                    opacity: animation,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: const Offset(0, .015),
                        end: Offset.zero,
                      ).animate(animation),
                      child: child,
                    ),
                  ),
                  child: offers.loadError != null && offers.offers.isEmpty
                      ? Column(
                          children: [
                            Text(offers.loadError!, style: ScheduleTokens.body),
                            TextButton(
                              onPressed: offers.refresh,
                              child: const Text('Retry'),
                            ),
                          ],
                        )
                      : _mySpace
                      ? _personal(data, loading)
                      : _organization(data, attendance, loading),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _organization(
    HomeDashboardData data,
    AttendanceProvider attendance,
    bool loading,
  ) {
    final live = attendance.active?.isOpen == true ? attendance.active : null;
    final today = live == null
        ? data.primary
        : context
              .read<OffersProvider>()
              .offers
              .where((offer) => offer.shiftId == live.shiftId)
              .firstOrNull;
    final role = live?.roleName ?? today?.roleName;
    final venue = live?.venueName ?? today?.venueName;
    final start = live?.startsAt ?? today?.startsAt;
    final end = live?.endsAt ?? today?.endsAt;
    // Only show supplementary fields when they belong to the displayed shift.
    final details = live == null || live.shiftId == today?.shiftId
        ? today
        : null;
    final height =
        208.0 +
        (MediaQuery.textScalerOf(context).scale(16) - 16).clamp(0, 32) *
            (MediaQuery.sizeOf(context).width < 360 ? 20 : 12);
    // A confirmed shift for today that has already ended (and was never
    // clocked into, or already clocked out) is a distinct real state from
    // "clockable now" — never offered as "Clock in" once its own endsAt has
    // passed (§4/§28: differentiate available vs completed, don't collapse
    // both into one fallback).
    final isCompletedToday =
        !loading &&
        live == null &&
        today != null &&
        (const {
              'clockedOut',
              'complete',
              'expired',
              'ended',
            }.contains(today.presentation?.state) ||
            (today.presentation == null &&
                DateTime.now().isAfter(today.endsAt)) ||
            attendance.history.any(
              (record) => record.shiftId == today.shiftId && record.hasEnded,
            ));
    final canClock =
        !loading &&
        (live != null ||
            (today != null &&
                !isCompletedToday &&
                (today.presentation?.isToday ?? data.today != null)));
    return Column(
      key: const ValueKey('organization-view'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        const Text('Offer Details', style: ScheduleTokens.heading),
        const SizedBox(height: 2),
        Text(
          loading ? 'Updating your offers…' : 'Your latest offers',
          style: ScheduleTokens.label,
        ),
        const SizedBox(height: 14),
        SizedBox(
          height: height,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                flex: 6,
                child: _primaryPanel(
                  today,
                  color: ScheduleTokens.homePeach,
                  // Priority matches the heading text below ("Live Shift" vs
                  // "Today's Shift"): a live clock-in always wins, so tapping
                  // never contradicts what the card just told the user it
                  // was showing (previously `today` took priority even while
                  // live, sending a tap on a card labelled "Live Shift" to
                  // the static confirmed-offer page instead of the running
                  // clock).
                  onTap: loading
                      ? null
                      : live != null
                      ? () => _push(const ScheduleClockScreen())
                      : today != null
                      ? () => _push(
                          ScheduleOfferDetailScreen(
                            offer: today,
                            visualStyle: ShiftVisualStyle.forShift(
                              today.shiftId,
                            ),
                          ),
                        )
                      : null,
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      Text(
                        today?.presentation?.homeLabel ??
                            (live != null
                                ? 'Live Shift'
                                : data.today == null && today != null
                                ? 'Next Shift'
                                : "Today's Shift"),
                        style: ScheduleTokens.label,
                      ),
                      const Divider(height: 12, color: ScheduleTokens.border),
                      if (loading)
                        const Expanded(
                          child: Center(
                            child: Text(
                              'Loading…',
                              style: ScheduleTokens.label,
                            ),
                          ),
                        )
                      else if (venue == null)
                        const Expanded(
                          child: Center(
                            child: Text(
                              'No shift today',
                              textAlign: TextAlign.center,
                              style: ScheduleTokens.body,
                            ),
                          ),
                        )
                      else ...[
                        Text(
                          role ?? '',
                          textAlign: TextAlign.left,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          style: ScheduleTokens.body.copyWith(
                            fontSize: 16,
                            fontWeight: FontWeight.w500,
                          ),
                        ),
                        const Spacer(),
                        Text(
                          venue,
                          maxLines: 2,
                          overflow: TextOverflow.ellipsis,
                          textAlign: TextAlign.left,
                          style: ScheduleTokens.body.copyWith(
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                        if (start != null)
                          Text(
                            DateFormat('EEE dd/MM/yy').format(start.toLocal()),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: ScheduleTokens.label.copyWith(fontSize: 11),
                          ),
                        if (details != null) ...[
                          const Spacer(),
                          Text.rich(
                            TextSpan(
                              children: [
                                const TextSpan(
                                  text: 'Pay rate : ',
                                  style: ScheduleTokens.label,
                                ),
                                TextSpan(
                                  text:
                                      '${formatPence(details.payRatePence)}/h',
                                  style: ScheduleTokens.body.copyWith(
                                    fontSize: 12,
                                  ),
                                ),
                              ],
                            ),
                          ),
                        ],
                        const Spacer(),
                        Text(
                          '${DateFormat('HH:mm').format(start!.toLocal())} – ${DateFormat('HH:mm').format(end!.toLocal())}',
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
                    Expanded(
                      child: SchedulePanel(
                        color: ScheduleTokens.homeMint,
                        onTap: loading ? null : _offers,
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const Text(
                              'Open Shift Offers',
                              style: ScheduleTokens.label,
                            ),
                            const SizedBox(height: 12),
                            Text(
                              loading
                                  ? 'Loading…'
                                  : '${data.pending} ${data.pending == 1 ? 'offer' : 'offers'} – View',
                              style: ScheduleTokens.body.copyWith(
                                fontSize: 18,
                                fontWeight: FontWeight.w700,
                              ),
                            ),
                            const Spacer(),
                            Text(
                              loading
                                  ? 'Checking shifts…'
                                  : '${data.confirmed} confirmed',
                              style: ScheduleTokens.label,
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 10),
                    Material(
                      color: ScheduleTokens.lavender,
                      borderRadius: BorderRadius.circular(16),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(16),
                        onTap: canClock
                            ? () => _push(const ScheduleClockScreen())
                            : null,
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(minHeight: 48),
                          child: Padding(
                            padding: const EdgeInsets.all(8),
                            child: Text(
                              // Every branch here is a distinct, real state —
                              // never a shared "Not available" fallback for
                              // loading/empty/completed alike (§28).
                              loading
                                  ? 'Loading…'
                                  : live != null
                                  ? 'Clock out'
                                  : isCompletedToday
                                  ? today.presentation?.label ?? 'Completed'
                                  : today != null
                                  ? (today.presentation?.isToday ??
                                            data.today != null)
                                        ? 'Clock in'
                                        : 'Be Ready'
                                  : 'No shift today',
                              textAlign: TextAlign.center,
                              style: ScheduleTokens.body.copyWith(
                                fontSize: 17,
                                color: canClock
                                    ? ScheduleTokens.ink
                                    : ScheduleTokens.muted,
                              ),
                            ),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 14),
        UpcomingShiftDeck(
          offers: data.upcoming,
          loading: loading,
          schedule: true,
          cardHeight: UpcomingShiftCard.homeHeightFor(context),
        ),
      ],
    );
  }

  Widget _personal(HomeDashboardData data, bool loading) => Column(
    key: const ValueKey('my-space-view'),
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      if (_dismissed.length < 2) ...[
        const Text('First steps', style: ScheduleTokens.heading),
        const SizedBox(height: 14),
        if (!_dismissed.contains('discover'))
          _step(
            'discover',
            'Discover the app',
            Icons.play_circle_outline,
            () => _explain(
              'Discover the app',
              'Review invitations in Offers, see confirmed shifts in Calendar, '
                  'and check completed work in History. Use the Home clock action for your scheduled shift.',
            ),
          ),
        if (!_dismissed.contains('availability'))
          _step(
            'availability',
            'My availability',
            Icons.check_circle_outline,
            () => _explain(
              'My availability',
              'Availability editing is not available in the staff app yet. '
                  'Contact your organization to update your availability.',
            ),
          ),
      ],
      const SizedBox(height: 6),
      const Text('Overview', style: ScheduleTokens.heading),
      const SizedBox(height: 14),
      Container(
        decoration: ScheduleTokens.panel(ScheduleTokens.surface),
        padding: const EdgeInsets.symmetric(vertical: 8),
        child: Column(
          children: [
            _overview(
              'Offers',
              Icons.event_available_outlined,
              loading ? '—' : '${data.pending}',
              _offers,
            ),
            _overview(
              'Confirmed',
              Icons.calendar_today_outlined,
              loading ? '—' : '${data.confirmed}',
              () => _push(const ScheduleOffersScreen(confirmed: true)),
            ),
            _overview(
              'Upcoming shift',
              Icons.schedule,
              loading ? '—' : '${data.upcoming.length}',
              _schedule,
            ),
            Tooltip(
              message: 'Payslips are not available in the staff app',
              child: _overview(
                'Payslip',
                Icons.receipt_long_outlined,
                '—',
                null,
              ),
            ),
          ],
        ),
      ),
    ],
  );

  Widget _step(
    String id,
    String title,
    IconData icon,
    VoidCallback onTap,
  ) => Padding(
    padding: const EdgeInsets.only(bottom: 12),
    child: DecoratedBox(
      decoration: ScheduleTokens.panel(ScheduleTokens.surface, lifted: true),
      child: ListTile(
        minTileHeight: 64,
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(24)),
        leading: Icon(icon, size: 20, color: ScheduleTokens.ink),
        title: Text(title, style: ScheduleTokens.body),
        onTap: onTap,
        trailing: IconButton(
          tooltip: 'Dismiss $title',
          icon: const Icon(Icons.close, size: 18),
          color: ScheduleTokens.muted,
          onPressed: () => setState(() => _dismissed.add(id)),
        ),
      ),
    ),
  );
  Widget _overview(
    String title,
    IconData icon,
    String count,
    VoidCallback? onTap,
  ) => ListTile(
    minTileHeight: 50,
    enabled: onTap != null,
    onTap: onTap,
    leading: Icon(icon, size: 20, color: ScheduleTokens.ink),
    title: Text(title, style: ScheduleTokens.body),
    trailing: Text(
      count,
      style: ScheduleTokens.label.copyWith(color: ScheduleTokens.ink),
    ),
  );
}
