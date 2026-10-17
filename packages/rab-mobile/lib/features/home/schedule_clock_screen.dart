export 'clock_presentation.dart' show ClockShiftTimer;
import 'clock_presentation.dart';
import 'shift_team_member.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_record_card.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/motion/shift_motion.dart';
import '../../core/services/location_service.dart';
import '../../core/theme/money.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/theme/shift_visual_style.dart';
import '../offers/offers_provider.dart';
import '../offers/offer_detail_ui_state.dart';
import 'attendance_provider.dart';
import 'location_permission_sheet.dart';
import 'location_unavailable_dialog.dart';
import 'qr_scan_screen.dart';
import 'todays_shift.dart';

/// Pastel presentation of the existing attendance provider and eligibility resolver.
class ScheduleClockScreen extends StatefulWidget {
  const ScheduleClockScreen({
    super.key,
    this.offer,
    this.teams = false,
    this.visualStyle = ShiftVisualStyle.yellow,
    @visibleForTesting this.locationResolver,
    @visibleForTesting this.qrScanner,
  });
  final OfferSummary? offer;
  final bool teams;
  final ShiftVisualStyle visualStyle;

  /// Test-only seam: overrides the real location-permission-sheet + GPS-fix
  /// sequence (`_resolveLocation`) so widget tests can drive Clock In/Out
  /// without a real location platform. Production call sites never set this
  /// — `null` (always, outside tests) means "use the real implementation".
  @visibleForTesting
  final Future<Position?> Function(BuildContext context)? locationResolver;

  /// Test-only seam: overrides pushing the real camera-backed `QrScanScreen`
  /// so widget tests can supply a fake scanned token without a real camera
  /// platform. `null` (always, outside tests) means "use the real screen".
  @visibleForTesting
  final Future<String?> Function(BuildContext context)? qrScanner;

  static Route<void> route({
    required OfferSummary offer,
    required ShiftVisualStyle visualStyle,
  }) => PageRouteBuilder<void>(
    pageBuilder: (_, _, _) =>
        ScheduleClockScreen(offer: offer, visualStyle: visualStyle),
    transitionDuration: const Duration(milliseconds: 220),
    reverseTransitionDuration: const Duration(milliseconds: 180),
    transitionsBuilder: (context, animation, _, child) => FadeTransition(
      opacity: animation,
      child: ShiftMotion.reduced(context)
          ? child
          : SlideTransition(
              position: Tween(begin: const Offset(0, .015), end: Offset.zero)
                  .animate(
                    CurvedAnimation(
                      parent: animation,
                      curve: Curves.easeOutCubic,
                    ),
                  ),
              child: child,
            ),
    ),
  );
  @override
  State<ScheduleClockScreen> createState() => _ScheduleClockScreenState();
}

class _ScheduleClockScreenState extends State<ScheduleClockScreen>
    with WidgetsBindingObserver {
  bool _busy = false, _expanded = false, _confirming = false;
  bool _earlyVisible = false;
  String? _completedAttendanceId;
  Timer? _boundary;
  DateTime? _scheduledBoundary;
  double _drag = 0;
  bool _teamLoading = false;
  String? _teamError;
  String? _teamShiftId;
  List<ShiftTeamMember> _team = [];
  Timer? _teamRefresh;

  @override
  void initState() {
    super.initState();
    if (widget.teams) {
      _teamRefresh = Timer.periodic(const Duration(seconds: 30), (_) {
        if (mounted && TickerMode.of(context) && widget.offer != null) {
          _loadTeam(widget.offer!.shiftId);
        }
      });
    }
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) {
        context.read<AttendanceProvider>().loadHistory();
        if (widget.teams && widget.offer != null) {
          _loadTeam(widget.offer!.shiftId);
        }
      }
    });
  }

  @override
  void dispose() {
    _boundary?.cancel();
    _teamRefresh?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      _scheduledBoundary = null;
      _refresh();
      if (_teamShiftId != null) {
        _loadTeam(_teamShiftId!);
      }
    }
  }

  // Resume-only (see `didChangeAppLifecycleState` above) — this screen
  // already has good data on it; a silent refresh just reconciles against
  // the server without flashing back to the loading state.
  Future<void> _refresh() async => Future.wait([
    context.read<OffersProvider>().refresh(),
    context.read<AttendanceProvider>().refreshActive(silent: true),
    context.read<AttendanceProvider>().loadHistory(silent: true),
  ]);

  OfferDetailUiState? _state(
    OfferSummary? offer,
    AttendanceProvider attendance,
    OffersProvider offers,
  ) {
    // Server success is known even if history is temporarily unavailable.
    if (_completedAttendanceId != null) return OfferDetailUiState.completed;
    if (attendance.isLoadingActive ||
        attendance.isLoadingHistory ||
        offers.isLoading) {
      return OfferDetailUiState.loading;
    }
    if (attendance.activeLoadError != null ||
        attendance.historyLoadError != null ||
        offers.loadError != null) {
      return OfferDetailUiState.error;
    }
    if (widget.offer != null && offer == null) return OfferDetailUiState.error;
    if (attendance.active?.isOpen == true &&
        (offer == null || attendance.active?.shiftId == offer.shiftId)) {
      return OfferDetailUiState.clockOut;
    }
    if (offer == null) return null;
    if (attendance.history.any(
      (entry) => entry.shiftId == offer.shiftId && entry.clockOutAt != null,
    )) {
      return OfferDetailUiState.completed;
    }
    final resolved = OfferDetailUiState.resolve(
      offer: offer,
      active: attendance.active,
      history: attendance.history,
      clockableShiftId: todaysConfirmedOffer(offers.offers)?.shiftId,
      now: attendance.trustedNow,
    );
    // A stale offer projection must not trigger Clock In while active
    // attendance is being reconciled, nor imply a recorded clock-out.
    if (resolved == OfferDetailUiState.clockOut ||
        resolved == OfferDetailUiState.clockedOut ||
        resolved == OfferDetailUiState.completed) {
      return OfferDetailUiState.loading;
    }
    return resolved;
  }

  /// Explain-first location permission → one-shot fix → "location
  /// unavailable" dialog on failure. Shared by clock-in and clock-out so
  /// there's exactly one place this sequence is written.
  Future<Position?> _resolveLocation() async {
    if (widget.locationResolver != null) {
      return widget.locationResolver!(context);
    }
    final permission = await Geolocator.checkPermission();
    if (permission == LocationPermission.denied) {
      if (!mounted) return null;
      final proceed = await showLocationPermissionSheet(context);
      if (proceed != true) return null;
    }
    final position = await LocationService().getCurrentPosition();
    if (!mounted) return null;
    if (position == null) {
      await showLocationUnavailableDialog(context);
      return null;
    }
    return position;
  }

  Future<String?> _scanQr() {
    if (widget.qrScanner != null) return widget.qrScanner!(context);
    return Navigator.of(context).push<String?>(QrScanScreen.route());
  }

  Future<void> _clockIn(OfferSummary offer) async {
    final attendance = context.read<AttendanceProvider>();
    if (_busy ||
        attendance.isBusy ||
        _state(offer, attendance, context.read<OffersProvider>()) !=
            OfferDetailUiState.clockIn) {
      return;
    }

    // A quick, non-authoritative UX check against the server-supplied clock
    // (never the device's own) — avoids sending someone through a location
    // + camera prompt only to be told it's too early. The backend enforces
    // the real window regardless (`ClockInTooEarlyException`); this only
    // saves a wasted round trip through permission prompts.
    final serverNow = attendance.trustedNow;
    if (serverNow != null && attendance.clockInEarlyMinutes != null) {
      final availableAt = offer.startsAt.subtract(
        Duration(minutes: attendance.clockInEarlyMinutes!),
      );
      if (serverNow.isBefore(availableAt)) {
        setState(() {
          _expanded = false;
          _earlyVisible = true;
        });
        await showModalBottomSheet<void>(
          context: context,
          isScrollControlled: true,
          barrierColor: Colors.transparent,
          backgroundColor: Colors.white,
          elevation: 16,
          shape: const RoundedRectangleBorder(
            borderRadius: BorderRadius.vertical(top: Radius.circular(24)),
          ),
          builder: (_) => ChangeNotifierProvider<AttendanceProvider>.value(
            value: attendance,
            child: ClockEarlySheet(availableAt: availableAt),
          ),
        );
        if (mounted) setState(() => _earlyVisible = false);
        return;
      }
    }

    setState(() => _busy = true);
    final position = await _resolveLocation();
    if (position == null) {
      if (mounted) setState(() => _busy = false);
      return;
    }
    if (!mounted) return;
    final token = await _scanQr();
    if (token == null) {
      if (mounted) setState(() => _busy = false);
      return;
    }
    final ok = await attendance.clockIn(
      offer.shiftId,
      qrToken: token,
      lat: position.latitude,
      lng: position.longitude,
      accuracyM: position.accuracy,
    );
    if (ok && mounted) await context.read<OffersProvider>().load(silent: true);
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _clockOut() async {
    final attendance = context.read<AttendanceProvider>();
    if (_busy ||
        _confirming ||
        attendance.isBusy ||
        attendance.active == null) {
      return;
    }
    final active = attendance.active!;
    var confirmationSubmitted = false;
    setState(
      () => _confirming = true,
    ); // Includes confirmation: repeated taps cannot open multiple sheets.
    final confirmed = await showScheduleSheet<bool>(
      context: context,
      builder: (context) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Text('End your shift?', style: ScheduleTokens.heading),
          const SizedBox(height: ScheduleTokens.sheetTextGap),
          const Text(
            'Ending your shift records your worked time when clock-out is confirmed.',
            style: ScheduleTokens.body,
          ),
          const SizedBox(height: ScheduleTokens.sheetActionGap),
          _clockButton('Clock out', () {
            if (confirmationSubmitted) return;
            confirmationSubmitted = true;
            Navigator.pop(context, true);
          }, key: const ValueKey('confirm-clock-out')),
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep working'),
          ),
        ],
      ),
    );
    if (!mounted) return;
    setState(() => _confirming = false);
    if (confirmed == true && attendance.active?.id == active.id) {
      setState(() => _busy = true);
      final position = await _resolveLocation();
      if (position == null) {
        if (mounted) setState(() => _busy = false);
        return;
      }
      if (!mounted) return;
      final token = await _scanQr();
      if (token == null) {
        if (mounted) setState(() => _busy = false);
        return;
      }
      final ok = await attendance.clockOut(
        qrToken: token,
        lat: position.latitude,
        lng: position.longitude,
        accuracyM: position.accuracy,
      );
      if (!mounted) return;
      if (ok) {
        _completedAttendanceId = active.id;
        await context.read<OffersProvider>().load(silent: true);
      }
    }
    if (mounted) setState(() => _busy = false);
  }

  Future<void> _openTeams(OfferSummary offer) async {
    await Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) => ScheduleClockScreen(
          offer: offer,
          teams: true,
          locationResolver: widget.locationResolver,
          qrScanner: widget.qrScanner,
        ),
      ),
    );
    if (mounted) await _refresh();
  }

  Future<void> _loadTeam(String shiftId) async {
    if (_teamLoading) return;
    setState(() {
      _teamShiftId = shiftId;
      _teamLoading = true;
      _teamError = null;
      _team = [];
    });
    try {
      final rows = await context.read<AttendanceProvider>().loadTeam(shiftId);
      if (mounted) setState(() => _team = rows);
    } catch (_) {
      if (mounted) {
        setState(
          () => _teamError = 'Unable to load your team. Please try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _teamLoading = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final attendance = context.watch<AttendanceProvider>();
    final offers = context.watch<OffersProvider>();
    final active = attendance.active?.isOpen == true ? attendance.active : null;
    final selected = widget.offer != null
        ? offers.offers.where((o) => o.id == widget.offer!.id).firstOrNull
        : active != null
        ? offers.offers.where((o) => o.shiftId == active.shiftId).firstOrNull
        : todaysConfirmedOffer(offers.offers);
    final state = _state(selected, attendance, offers);
    final live = state == OfferDetailUiState.clockOut ? active : null;
    final record = _completedAttendanceId != null
        ? attendance.history
              .where(
                (a) => a.id == _completedAttendanceId && a.clockOutAt != null,
              )
              .firstOrNull
        : live ??
              attendance.history
                  .where(
                    (a) =>
                        a.shiftId == selected?.shiftId && a.clockOutAt != null,
                  )
                  .firstOrNull;
    final completed = state == OfferDetailUiState.completed;
    final awaitingMetrics = completed && record?.workedMinutes == null;
    final starts = record?.startsAt ?? selected?.startsAt;
    final ends = record?.endsAt ?? selected?.endsAt;
    final now = attendance.trustedNow;
    final opensAt = starts != null && attendance.clockInEarlyMinutes != null
        ? starts.subtract(Duration(minutes: attendance.clockInEarlyMinutes!))
        : null;
    final nextBoundary = now == null
        ? null
        : [opensAt, starts, ends]
              .whereType<DateTime>()
              .where((date) => date.isAfter(now))
              .firstOrNull;
    if (nextBoundary != _scheduledBoundary && now != null) {
      _scheduledBoundary = nextBoundary;
      _boundary?.cancel();
      if (nextBoundary != null) {
        _boundary = Timer(
          nextBoundary.difference(now) + const Duration(milliseconds: 10),
          () {
            if (mounted) _refresh();
          },
        );
      }
    }
    final confirmed =
        state == OfferDetailUiState.clockIn ||
        state == OfferDetailUiState.ready;
    final status = switch (state) {
      OfferDetailUiState.clockIn ||
      OfferDetailUiState.ready => 'Shift confirmed',
      OfferDetailUiState.clockOut => 'Clocked In',
      OfferDetailUiState.completed => 'Clocked Out',
      OfferDetailUiState.ended => 'Shift ended',
      OfferDetailUiState.cancelled => 'Shift cancelled',
      null => 'No shift today',
      _ => state.label,
    };
    final canTeam =
        selected != null && confirmed || live != null && selected != null;
    if (canTeam && _teamShiftId != selected.shiftId && !_teamLoading) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) _loadTeam(selected.shiftId);
      });
    }
    final busy = _busy || _confirming || attendance.isBusy;
    final timer = awaitingMetrics
        ? const ClockStatusBadge(label: 'Clocked Out')
        : ClockShiftTimer(
            startsAt: starts,
            endsAt: ends,
            attendance: record,
            live: live != null,
            completed: completed,
            confirmed: confirmed,
            status: status,
            team: widget.teams,
            isToday:
                selected?.presentation?.isToday ??
                (now != null &&
                    starts != null &&
                    DateUtils.isSameDay(now.toLocal(), starts.toLocal())),
          );
    final action = state == OfferDetailUiState.loading
        ? const SizedBox(
            height: 48,
            child: Center(child: CircularProgressIndicator()),
          )
        : state == OfferDetailUiState.error
        ? _clockButton('Retry', _refresh)
        : state == OfferDetailUiState.clockIn ||
              state == OfferDetailUiState.clockOut
        ? _clockButton(
            live != null ? 'Clock out' : 'Clock in',
            busy
                ? null
                : live != null
                ? _clockOut
                : () => _clockIn(selected!),
            busy: _busy || attendance.isBusy,
            key: const ValueKey('clock-primary'),
          )
        : _clockButton(
            completed
                ? widget.teams
                      ? 'Back to shift'
                      : 'View shift summary'
                : 'Back to shifts',
            () {
              if (completed && !widget.teams) {
                setState(() => _expanded = true);
              } else {
                Navigator.maybePop(context);
              }
            },
          );
    final error =
        attendance.errorMessage ??
        (state == OfferDetailUiState.error
            ? attendance.activeLoadError ??
                  attendance.historyLoadError ??
                  offers.loadError ??
                  'Unable to check shift.'
            : null);
    final venue = record?.venueName ?? selected?.venueName ?? 'Your shift';
    final address = selected?.venueAddress?.trim();
    final venueHeader = Row(
      children: [
        Container(
          width: 32,
          height: 32,
          decoration: BoxDecoration(
            color: ScheduleTokens.lavender,
            borderRadius: BorderRadius.circular(12),
          ),
          child: const Icon(
            Icons.shopping_bag_outlined,
            size: 20,
            color: ScheduleTokens.ink,
          ),
        ),
        const SizedBox(width: 10),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                venue,
                style: ScheduleTokens.body.copyWith(
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                  color: widget.teams ? Colors.white : ScheduleTokens.ink,
                ),
              ),
              if (address?.isNotEmpty == true)
                Text(
                  address!,
                  style: ScheduleTokens.label.copyWith(
                    fontSize: 8,
                    color: widget.teams ? Colors.white70 : ScheduleTokens.muted,
                  ),
                ),
            ],
          ),
        ),
        if (!widget.teams)
          IconButton(
            key: const ValueKey('clock-expand'),
            tooltip: _expanded ? 'Collapse details' : 'Expand details',
            onPressed: () => setState(() => _expanded = !_expanded),
            style: IconButton.styleFrom(backgroundColor: Colors.white),
            constraints: const BoxConstraints.tightFor(width: 32, height: 32),
            padding: EdgeInsets.zero,
            icon: Icon(
              _expanded ? Icons.south_east : Icons.north_east,
              size: 18,
            ),
          ),
      ],
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark,
      child: Scaffold(
        backgroundColor: ScheduleTokens.homeBackground,
        body: SafeArea(
          child: Padding(
            padding: EdgeInsets.fromLTRB(
              widget.teams ? 20 : 0,
              8,
              widget.teams ? 20 : 0,
              0,
            ),
            child: Column(
              children: [
                ClockHeader(
                  title: widget.teams
                      ? 'Teams'
                      : live != null
                      ? 'Clock out'
                      : 'Clock in',
                ),
                const SizedBox(height: 12),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, box) {
                      if (widget.teams) {
                        return Column(
                          children: [
                            Expanded(
                              child: RefreshIndicator(
                                onRefresh: () async {
                                  await _refresh();
                                  if (selected != null) {
                                    await _loadTeam(selected.shiftId);
                                  }
                                },
                                child: ListView(
                                  physics:
                                      const AlwaysScrollableScrollPhysics(),
                                  children: [
                                    Container(
                                      padding: const EdgeInsets.all(13),
                                      decoration: BoxDecoration(
                                        color: ClockPalette.navy,
                                        borderRadius: BorderRadius.circular(22),
                                      ),
                                      child: Column(
                                        crossAxisAlignment:
                                            CrossAxisAlignment.start,
                                        children: [
                                          venueHeader,
                                          const SizedBox(height: 10),
                                          timer,
                                        ],
                                      ),
                                    ),
                                    const SizedBox(height: 20),
                                    if (_teamLoading)
                                      const Center(
                                        child: CircularProgressIndicator(),
                                      )
                                    else if (_teamError != null)
                                      ScheduleMessageCard(
                                        title: 'Team unavailable',
                                        message: _teamError,
                                        kind: ScheduleMessageKind.error,
                                        actionLabel: 'Retry',
                                        onAction: selected == null
                                            ? null
                                            : () => _loadTeam(selected.shiftId),
                                      )
                                    else if (!canTeam)
                                      const ScheduleMessageCard(
                                        title: 'Team unavailable',
                                        message:
                                            'Team visibility requires a current confirmed assignment.',
                                      )
                                    else if (_team.isEmpty)
                                      const ScheduleMessageCard(
                                        title: 'No confirmed teammates yet',
                                      )
                                    else
                                      ..._team.map(
                                        (member) => Container(
                                          margin: const EdgeInsets.only(
                                            bottom: 12,
                                          ),
                                          padding: const EdgeInsets.symmetric(
                                            horizontal: 16,
                                            vertical: 8,
                                          ),
                                          decoration: BoxDecoration(
                                            color: Colors.white,
                                            borderRadius: BorderRadius.circular(
                                              18,
                                            ),
                                          ),
                                          child: Row(
                                            children: [
                                              Expanded(
                                                child: Text(
                                                  member.isYou
                                                      ? '${member.displayName} (You)'
                                                      : member.displayName,
                                                  style: ScheduleTokens.body
                                                      .copyWith(
                                                        fontSize: 10,
                                                        fontFamily: 'Roboto',
                                                        fontWeight:
                                                            FontWeight.w500,
                                                      ),
                                                ),
                                              ),
                                              Text(
                                                '${DateFormat('HH:mm').format(member.startsAt.toLocal())} – ${DateFormat('HH:mm').format(member.endsAt.toLocal())}',
                                                style: ScheduleTokens.label
                                                    .copyWith(
                                                      fontSize: 10,
                                                      fontFamily: 'Roboto',
                                                      color: ScheduleTokens.ink,
                                                    ),
                                              ),
                                            ],
                                          ),
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ),
                            if (error != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: ScheduleMessageCard(
                                  title: 'Attendance update unsuccessful',
                                  message: error,
                                  kind: ScheduleMessageKind.error,
                                ),
                              ),
                            const SizedBox(height: 12),
                            action,
                          ],
                        );
                      }
                      // The hero stays behind the expanding card. Short/large-text
                      // layouts retain a bounded card scroll area and pinned actions.
                      final compact =
                          box.maxHeight < 500 ||
                          MediaQuery.textScalerOf(context).scale(14) > 20;
                      final height = _expanded
                          ? box.maxHeight * (compact ? .88 : .76)
                          : compact
                          ? box.maxHeight * .64
                          : (box.maxWidth * .738).clamp(
                              236.0,
                              box.maxHeight * (compact ? .70 : .55),
                            );
                      return Stack(
                        clipBehavior: Clip.hardEdge,
                        children: [
                          Positioned(
                            top: compact ? 4 : box.maxHeight * .12,
                            left: 22,
                            right: 20,
                            child: timer,
                          ),
                          if (selected != null)
                            Positioned(
                              top: box.maxHeight * .31,
                              right: -box.maxWidth * .13,
                              child: ExcludeSemantics(
                                child: ClipOval(
                                  child: Image.asset(
                                    'assets/onboarding/hero.jpg',
                                    width: box.maxWidth * .66,
                                    height: box.maxWidth * .66,
                                    fit: BoxFit.cover,
                                    cacheWidth: 900,
                                  ),
                                ),
                              ),
                            ),
                          if (!_earlyVisible)
                            AnimatedPositioned(
                              duration: ShiftMotion.reduced(context)
                                  ? Duration.zero
                                  : const Duration(milliseconds: 380),
                              curve: Curves.easeOutCubic,
                              left: _expanded ? 0 : 20,
                              right: _expanded ? 0 : 20,
                              bottom: 0,
                              child: AnimatedContainer(
                                key: const ValueKey('clock-shift-sheet'),
                                height: height,
                                duration: ShiftMotion.reduced(context)
                                    ? Duration.zero
                                    : const Duration(milliseconds: 380),
                                curve: Curves.easeOutCubic,
                                padding: const EdgeInsets.fromLTRB(
                                  15,
                                  0,
                                  15,
                                  10,
                                ),
                                decoration: BoxDecoration(
                                  gradient: ClockPalette.gradient,
                                  borderRadius: BorderRadius.circular(28),
                                ),
                                child: Column(
                                  children: [
                                    GestureDetector(
                                      behavior: HitTestBehavior.opaque,
                                      onVerticalDragStart: (_) => _drag = 0,
                                      onVerticalDragUpdate: (d) =>
                                          _drag += d.delta.dy,
                                      onVerticalDragEnd: (_) {
                                        if (_drag.abs() > 16) {
                                          setState(() => _expanded = _drag < 0);
                                        }
                                      },
                                      child: Semantics(
                                        button: true,
                                        label: _expanded
                                            ? 'Collapse shift information'
                                            : 'Expand shift information',
                                        child: InkWell(
                                          onTap: () => setState(
                                            () => _expanded = !_expanded,
                                          ),
                                          child: const SizedBox(
                                            height: 14,
                                            width: double.infinity,
                                          ),
                                        ),
                                      ),
                                    ),
                                    Expanded(
                                      child: SingleChildScrollView(
                                        key: const ValueKey(
                                          'clock-sheet-scroll',
                                        ),
                                        child: Column(
                                          crossAxisAlignment:
                                              CrossAxisAlignment.start,
                                          children: [
                                            venueHeader,
                                            const Divider(
                                              height: 12,
                                              color: ScheduleTokens.border,
                                            ),
                                            Row(
                                              crossAxisAlignment:
                                                  CrossAxisAlignment.start,
                                              children: [
                                                Expanded(
                                                  child: _field(
                                                    'ROLE',
                                                    record?.roleName ??
                                                        selected?.roleName ??
                                                        'No shift assigned today.',
                                                  ),
                                                ),
                                                if (selected != null) ...[
                                                  const SizedBox(width: 12),
                                                  Expanded(
                                                    child: _field(
                                                      'PAY RATE',
                                                      '${formatPence(selected.payRatePence)}/h',
                                                    ),
                                                  ),
                                                ],
                                              ],
                                            ),
                                            const SizedBox(height: 2),
                                            if (_expanded &&
                                                starts != null &&
                                                ends != null)
                                              Padding(
                                                padding: const EdgeInsets.only(
                                                  top: 8,
                                                ),
                                                child: Row(
                                                  children: [
                                                    const Icon(
                                                      Icons.access_time,
                                                      size: 14,
                                                    ),
                                                    const SizedBox(width: 8),
                                                    Text(
                                                      '${DateFormat("HH:mm").format(starts.toLocal())} – ${DateFormat("HH:mm").format(ends.toLocal())}',
                                                      style: ScheduleTokens.body
                                                          .copyWith(
                                                            fontSize: 12,
                                                          ),
                                                    ),
                                                  ],
                                                ),
                                              ),
                                            if (canTeam)
                                              TextButton(
                                                style: TextButton.styleFrom(
                                                  foregroundColor:
                                                      ScheduleTokens.muted,
                                                  padding: EdgeInsets.zero,
                                                  textStyle: Theme.of(context)
                                                      .textTheme
                                                      .labelLarge!
                                                      .copyWith(fontSize: 10),
                                                  minimumSize: const Size(
                                                    0,
                                                    28,
                                                  ),
                                                  tapTargetSize:
                                                      MaterialTapTargetSize
                                                          .shrinkWrap,
                                                ),
                                                onPressed: busy
                                                    ? null
                                                    : () =>
                                                          _openTeams(selected),
                                                child: Row(
                                                  children: [
                                                    const Expanded(
                                                      child: Text('Your team'),
                                                    ),
                                                    if (_team.isNotEmpty &&
                                                        _teamShiftId ==
                                                            selected.shiftId)
                                                      SizedBox(
                                                        width: 70,
                                                        height: 22,
                                                        child: FittedBox(
                                                          alignment: Alignment
                                                              .centerRight,
                                                          child: ScheduleAvatarStack(
                                                            names: _team
                                                                .map(
                                                                  (
                                                                    member,
                                                                  ) => member
                                                                      .displayName,
                                                                )
                                                                .toList(),
                                                          ),
                                                        ),
                                                      ),
                                                  ],
                                                ),
                                              ),
                                            if (!_expanded)
                                              TextButton(
                                                style: TextButton.styleFrom(
                                                  foregroundColor:
                                                      ScheduleTokens.ink,
                                                  padding: EdgeInsets.zero,
                                                  textStyle: Theme.of(context)
                                                      .textTheme
                                                      .labelLarge!
                                                      .copyWith(fontSize: 10),
                                                  minimumSize: const Size(
                                                    0,
                                                    28,
                                                  ),
                                                  tapTargetSize:
                                                      MaterialTapTargetSize
                                                          .shrinkWrap,
                                                ),
                                                onPressed: () => setState(
                                                  () => _expanded = true,
                                                ),
                                                child: const Text(
                                                  'View shift details & dress code',
                                                ),
                                              ),
                                            if (_expanded) ...[
                                              const SizedBox(height: 6),
                                              Center(
                                                child: Container(
                                                  padding:
                                                      const EdgeInsets.symmetric(
                                                        horizontal: 52,
                                                        vertical: 8,
                                                      ),
                                                  decoration: const BoxDecoration(
                                                    color:
                                                        ScheduleTokens.yellow,
                                                    borderRadius:
                                                        BorderRadius.vertical(
                                                          top: Radius.circular(
                                                            14,
                                                          ),
                                                        ),
                                                  ),
                                                  child: const Text(
                                                    'NOTE',
                                                    style: TextStyle(
                                                      fontSize: 11,
                                                      fontWeight:
                                                          FontWeight.w600,
                                                    ),
                                                  ),
                                                ),
                                              ),
                                              Container(
                                                width: double.infinity,
                                                constraints:
                                                    const BoxConstraints(
                                                      minHeight: 176,
                                                    ),
                                                padding:
                                                    const EdgeInsets.fromLTRB(
                                                      12,
                                                      28,
                                                      12,
                                                      18,
                                                    ),
                                                decoration: BoxDecoration(
                                                  color: Colors.white,
                                                  borderRadius:
                                                      BorderRadius.circular(24),
                                                ),
                                                child: Text(
                                                  selected?.shiftNotes
                                                              ?.trim()
                                                              .isNotEmpty ==
                                                          true
                                                      ? selected!.shiftNotes!
                                                            .trim()
                                                      : 'No shift notes provided.',
                                                  style: ScheduleTokens.body
                                                      .copyWith(
                                                        fontSize: 11,
                                                        height: 1.18,
                                                        fontWeight:
                                                            FontWeight.w500,
                                                      ),
                                                ),
                                              ),
                                              const SizedBox(height: 12),
                                            ],
                                            if (completed)
                                              ScheduleMessageCard(
                                                key: const ValueKey(
                                                  'clock-status',
                                                ),
                                                title: 'Shift completed',
                                                message: awaitingMetrics
                                                    ? 'Updating worked time…'
                                                    : '${record!.workedMinutes} minutes worked',
                                                kind:
                                                    ScheduleMessageKind.success,
                                              ),
                                            if (awaitingMetrics)
                                              TextButton(
                                                onPressed:
                                                    attendance.isLoadingHistory
                                                    ? null
                                                    : attendance.loadHistory,
                                                child: const Text(
                                                  'Refresh worked time',
                                                ),
                                              ),
                                          ],
                                        ),
                                      ),
                                    ),
                                    const SizedBox(height: 8),
                                    if (error != null)
                                      ConstrainedBox(
                                        constraints: BoxConstraints(
                                          maxHeight: height * .35,
                                        ),
                                        child: SingleChildScrollView(
                                          child: Padding(
                                            padding: const EdgeInsets.only(
                                              bottom: 8,
                                            ),
                                            child: ScheduleMessageCard(
                                              title:
                                                  'Attendance update unsuccessful',
                                              message: error,
                                              kind: ScheduleMessageKind.error,
                                            ),
                                          ),
                                        ),
                                      ),
                                    if (_expanded && canTeam)
                                      Row(
                                        children: [
                                          Expanded(
                                            child: OutlinedButton(
                                              onPressed: busy
                                                  ? null
                                                  : () => _openTeams(selected),
                                              style: OutlinedButton.styleFrom(
                                                backgroundColor: Colors.white,
                                                foregroundColor:
                                                    ScheduleTokens.ink,
                                                side: BorderSide.none,
                                                shape: const StadiumBorder(),
                                                textStyle: Theme.of(context)
                                                    .textTheme
                                                    .labelLarge!
                                                    .copyWith(
                                                      fontSize: 12,
                                                      fontWeight:
                                                          FontWeight.w600,
                                                    ),
                                                minimumSize: const Size(0, 48),
                                              ),
                                              child: const Text('Teams'),
                                            ),
                                          ),
                                          const SizedBox(width: 8),
                                          Expanded(child: action),
                                        ],
                                      )
                                    else
                                      action,
                                  ],
                                ),
                              ),
                            ),
                        ],
                      );
                    },
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

Widget _field(String label, String value) => Column(
  crossAxisAlignment: label == 'PAY RATE'
      ? CrossAxisAlignment.end
      : CrossAxisAlignment.start,
  children: [
    Text(
      label,
      style: ScheduleTokens.label.copyWith(fontSize: 8, letterSpacing: 0),
    ),
    const SizedBox(height: 3),
    Text(
      value,
      style: ScheduleTokens.body.copyWith(
        fontSize: 12,
        fontWeight: FontWeight.w600,
      ),
    ),
  ],
);
Widget _clockButton(
  String label,
  VoidCallback? onPressed, {
  bool busy = false,
  Key? key,
}) => Builder(
  builder: (context) => Theme(
    data: Theme.of(context).copyWith(
      textTheme: Theme.of(context).textTheme.copyWith(
        labelLarge: Theme.of(
          context,
        ).textTheme.labelLarge!.copyWith(fontSize: 12),
      ),
    ),
    child: SchedulePrimaryButton(
      key: key,
      label: label,
      onPressed: onPressed,
      busy: busy,
    ),
  ),
);
