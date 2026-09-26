import '../../core/widgets/schedule_record_card.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'dart:async';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:geolocator/geolocator.dart';
import 'package:intl/intl.dart';
import 'package:provider/provider.dart';
import '../../core/models/offer.dart';
import '../../core/models/attendance.dart';
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
    this.visualStyle = ShiftVisualStyle.yellow,
    @visibleForTesting this.locationResolver,
    @visibleForTesting this.qrScanner,
  });
  final OfferSummary? offer;
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
  String? _completedAttendanceId;
  Timer? _boundary;
  DateTime? _scheduledBoundary;
  double _drag = 0;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.read<AttendanceProvider>().loadHistory();
    });
  }

  @override
  void dispose() {
    _boundary?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) _refresh();
  }

  Future<void> _refresh() async => Future.wait([
    context.read<OffersProvider>().refresh(),
    context.read<AttendanceProvider>().refreshActive(),
    context.read<AttendanceProvider>().loadHistory(),
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
    if ([
          'clockedOut',
          'complete',
          'expired',
        ].contains(offer.presentation?.state) &&
        attendance.history.any(
          (entry) => entry.shiftId == offer.shiftId && entry.hasEnded,
        )) {
      return OfferDetailUiState.completed;
    }
    return OfferDetailUiState.resolve(
      offer: offer,
      active: attendance.active,
      history: attendance.history,
      clockableShiftId: todaysConfirmedOffer(offers.offers)?.shiftId,
    );
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
    final serverNow = attendance.serverNow;
    if (serverNow != null) {
      final availableAt = offer.startsAt.subtract(const Duration(minutes: 15));
      if (serverNow.isBefore(availableAt)) {
        final formatted = DateFormat('h:mm a').format(availableAt.toLocal());
        await showScheduleMessageSheet(
          context: context,
          title: 'Not yet available',
          message:
              "Clock-in isn't available yet. You can clock in from $formatted.",
          kind: ScheduleMessageKind.info,
        );
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
            'Your worked hours will be recorded up to now.',
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
    setState(() => _busy = false);
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
              .where((a) => a.id == _completedAttendanceId && a.hasEnded)
              .firstOrNull
        : live ??
              attendance.history
                  .where((a) => a.shiftId == selected?.shiftId && a.hasEnded)
                  .firstOrNull;
    final awaitingMetrics =
        state == OfferDetailUiState.completed &&
        (record == null || record.workedMinutes == null);
    final venue = record?.venueName ?? selected?.venueName;
    final role = record?.roleName ?? selected?.roleName;
    final starts = record?.startsAt ?? selected?.startsAt;
    final ends = record?.endsAt ?? selected?.endsAt;
    if (ends != _scheduledBoundary) {
      _scheduledBoundary = ends;
      _boundary?.cancel();
      if (ends != null && ends.isAfter(DateTime.now())) {
        _boundary = Timer(
          ends.difference(DateTime.now()) + const Duration(milliseconds: 10),
          () {
            if (mounted) setState(() {});
          },
        );
      }
    }
    final shiftId =
        record?.shiftId ?? selected?.shiftId ?? widget.offer?.shiftId;
    final style = shiftId == null
        ? widget.visualStyle
        : ShiftVisualStyle.forShift(shiftId);
    final status = switch (state) {
      OfferDetailUiState.clockIn => 'Ready to clock in',
      OfferDetailUiState.clockOut => 'Clocked in',
      OfferDetailUiState.ready => 'Be Ready',
      OfferDetailUiState.completed => 'Shift completed',
      OfferDetailUiState.ended => 'Shift ended',
      null => 'No shift today',
      _ => state.label,
    };
    final bottom = MediaQuery.viewPaddingOf(context).bottom;
    final extraText = (MediaQuery.textScalerOf(context).scale(14) - 14).clamp(
      0,
      28,
    );
    return AnnotatedRegion<SystemUiOverlayStyle>(
      value: SystemUiOverlayStyle.dark.copyWith(
        statusBarColor: Colors.transparent,
        systemNavigationBarColor: Colors.transparent,
      ),
      child: Scaffold(
        backgroundColor: style.clockBackground,
        body: SafeArea(
          bottom: false,
          child: LayoutBuilder(
            builder: (context, box) {
              final collapsed = math.min(
                box.maxHeight * .52,
                248 +
                    bottom +
                    extraText * 6 +
                    (state == OfferDetailUiState.completed ? 84 : 0) +
                    (attendance.errorMessage != null ? 80 : 0),
              );
              final expanded = math.max(
                collapsed,
                box.maxHeight - math.max(64, box.maxHeight * .23),
              );
              return Stack(
                children: [
                  Positioned(
                    top: 10,
                    left: 16,
                    child: IconButton(
                      tooltip: 'Back',
                      onPressed: () => Navigator.maybePop(context),
                      icon: Container(
                        width: 42,
                        height: 42,
                        decoration: const BoxDecoration(
                          color: Colors.white,
                          shape: BoxShape.circle,
                          boxShadow: ScheduleTokens.homeShadows,
                        ),
                        child: const Icon(
                          Icons.chevron_left,
                          color: ScheduleTokens.ink,
                          size: 22,
                        ),
                      ),
                    ),
                  ),
                  Positioned(
                    top: (box.maxHeight * .16).clamp(82, 132),
                    left: 0,
                    right: 0,
                    child: Center(
                      child: awaitingMetrics
                          ? const Icon(
                              Icons.check_circle_outline,
                              size: 96,
                              color: ScheduleTokens.ink,
                            )
                          : ClockShiftTimer(
                              startsAt: starts,
                              endsAt: ends,
                              attendance: record,
                              live: live != null,
                              completed: state == OfferDetailUiState.completed,
                              status: status,
                              visualStyle: style,
                            ),
                    ),
                  ),
                  Align(
                    alignment: Alignment.bottomCenter,
                    child: AnimatedContainer(
                      key: const ValueKey('clock-shift-sheet'),
                      duration: ShiftMotion.reduced(context)
                          ? Duration.zero
                          : const Duration(milliseconds: 380),
                      curve: const Cubic(.22, 1, .36, 1),
                      height: _expanded ? expanded : collapsed,
                      clipBehavior: Clip.antiAlias,
                      decoration: BoxDecoration(
                        gradient: style.clockSheetGradient,
                        borderRadius: const BorderRadius.vertical(
                          top: Radius.circular(30),
                        ),
                      ),
                      child: Padding(
                        padding: EdgeInsets.fromLTRB(20, 0, 20, bottom + 12),
                        child: Column(
                          children: [
                            GestureDetector(
                              behavior: HitTestBehavior.opaque,
                              onVerticalDragStart: (_) => _drag = 0,
                              onVerticalDragUpdate: (d) => _drag += d.delta.dy,
                              onVerticalDragEnd: (d) {
                                if (_drag.abs() > 16 ||
                                    (d.primaryVelocity ?? 0).abs() > 100) {
                                  setState(
                                    () => _expanded =
                                        _drag < 0 ||
                                        (d.primaryVelocity ?? 0) < -100,
                                  );
                                }
                              },
                              child: Semantics(
                                button: true,
                                label: _expanded
                                    ? 'Collapse shift information'
                                    : 'Expand shift information',
                                child: InkWell(
                                  onTap: () =>
                                      setState(() => _expanded = !_expanded),
                                  child: SizedBox(
                                    height: 20,
                                    width: double.infinity,
                                    child: Center(
                                      child: Container(
                                        width: 32,
                                        height: 3,
                                        decoration: BoxDecoration(
                                          color: style.surfaceBorder,
                                          borderRadius: BorderRadius.circular(
                                            2,
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                            Expanded(
                              child: SingleChildScrollView(
                                key: const ValueKey('clock-sheet-scroll'),
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        CircleAvatar(
                                          radius: 20,
                                          backgroundColor: style.iconTile,
                                          child: const Icon(
                                            Icons.work_outline_rounded,
                                            color: ScheduleTokens.ink,
                                            size: 22,
                                          ),
                                        ),
                                        const SizedBox(width: 12),
                                        Expanded(
                                          child: Column(
                                            crossAxisAlignment:
                                                CrossAxisAlignment.start,
                                            children: [
                                              Text(
                                                venue ?? 'Your shift',
                                                style: ScheduleTokens.body
                                                    .copyWith(
                                                      fontWeight:
                                                          FontWeight.w600,
                                                    ),
                                              ),
                                              if (selected?.venueAddress
                                                      ?.trim()
                                                      .isNotEmpty ==
                                                  true)
                                                Text(
                                                  selected!.venueAddress!,
                                                  style: ScheduleTokens.label
                                                      .copyWith(fontSize: 10),
                                                ),
                                            ],
                                          ),
                                        ),
                                        IconButton(
                                          key: const ValueKey('clock-expand'),
                                          tooltip: _expanded
                                              ? 'Collapse details'
                                              : 'Expand details',
                                          onPressed: () => setState(
                                            () => _expanded = !_expanded,
                                          ),
                                          icon: Container(
                                            width: 32,
                                            height: 32,
                                            decoration: BoxDecoration(
                                              color: Colors.white,
                                              borderRadius:
                                                  BorderRadius.circular(12),
                                            ),
                                            child: Icon(
                                              _expanded
                                                  ? Icons.south_west
                                                  : Icons.north_east,
                                              size: 18,
                                            ),
                                          ),
                                        ),
                                      ],
                                    ),
                                    Divider(
                                      height: 28,
                                      color: style.surfaceBorder,
                                    ),
                                    Row(
                                      crossAxisAlignment:
                                          CrossAxisAlignment.start,
                                      children: [
                                        Expanded(
                                          flex: 3,
                                          child: _field(
                                            'ROLE',
                                            role ?? 'No shift assigned today.',
                                          ),
                                        ),
                                        if (_expanded && selected != null) ...[
                                          const SizedBox(width: 16),
                                          Flexible(
                                            child: _field(
                                              'PAY',
                                              '${formatPence(selected.payRatePence)}/h',
                                            ),
                                          ),
                                        ],
                                      ],
                                    ),
                                    if (_expanded) ...[
                                      const SizedBox(
                                        height: ScheduleTokens.sheetActionGap,
                                      ),
                                      if (starts != null && ends != null)
                                        _field(
                                          'TIME',
                                          '${DateFormat('HH:mm').format(starts.toLocal())}–${DateFormat('HH:mm').format(ends.toLocal())}',
                                        ),
                                      const SizedBox(
                                        height: ScheduleTokens.sheetActionGap,
                                      ),
                                      if ((record?.staffName ??
                                              selected?.staffName ??
                                              '')
                                          .trim()
                                          .isNotEmpty)
                                        _member(
                                          record?.staffName ??
                                              selected!.staffName,
                                          style,
                                        ),
                                      if (selected?.shiftNotes
                                              ?.trim()
                                              .isNotEmpty ==
                                          true) ...[
                                        const SizedBox(height: 18),
                                        Center(
                                          child: Container(
                                            width: 150,
                                            padding: const EdgeInsets.symmetric(
                                              vertical: 8,
                                            ),
                                            decoration: BoxDecoration(
                                              color: style.noteChip,
                                              borderRadius:
                                                  const BorderRadius.vertical(
                                                    top: Radius.circular(16),
                                                  ),
                                            ),
                                            child: const Text(
                                              'NOTE',
                                              textAlign: TextAlign.center,
                                              style: TextStyle(
                                                fontSize: 12,
                                                fontWeight: FontWeight.w600,
                                              ),
                                            ),
                                          ),
                                        ),
                                        Container(
                                          width: double.infinity,
                                          constraints: const BoxConstraints(
                                            minHeight: 200,
                                          ),
                                          padding: const EdgeInsets.all(18),
                                          decoration: BoxDecoration(
                                            color: Colors.white,
                                            borderRadius: BorderRadius.circular(
                                              24,
                                            ),
                                            boxShadow: style.noteShadows,
                                          ),
                                          child: Text(
                                            selected!.shiftNotes!.trim(),
                                            style: ScheduleTokens.body,
                                          ),
                                        ),
                                      ],
                                    ],
                                    const SizedBox(
                                      height: ScheduleTokens.sheetTextGap,
                                    ),
                                  ],
                                ),
                              ),
                            ),
                            if (attendance.errorMessage != null)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: ScheduleMessageCard(
                                  title: 'Attendance update unsuccessful',
                                  message: attendance.errorMessage!,
                                  kind: ScheduleMessageKind.error,
                                ),
                              ),
                            if (state == OfferDetailUiState.error)
                              Padding(
                                padding: const EdgeInsets.only(bottom: 8),
                                child: ScheduleMessageCard(
                                  title:
                                      attendance.activeLoadError ??
                                      attendance.historyLoadError ??
                                      offers.loadError ??
                                      'Could not check shift.',
                                  kind: ScheduleMessageKind.error,
                                ),
                              ),
                            if (state == OfferDetailUiState.loading)
                              const SizedBox(
                                height: 50,
                                child: Center(
                                  child: CircularProgressIndicator(),
                                ),
                              )
                            else if (state == OfferDetailUiState.error)
                              _clockButton('Retry', _refresh)
                            else if (state == OfferDetailUiState.clockIn ||
                                state == OfferDetailUiState.clockOut)
                              _clockButton(
                                live != null ? 'Clock out' : 'Clock in',
                                _busy || _confirming || attendance.isBusy
                                    ? null
                                    : live != null
                                    ? _clockOut
                                    : () => _clockIn(selected!),
                                busy: _busy || attendance.isBusy,
                                key: const ValueKey('clock-primary'),
                              )
                            else if (state == OfferDetailUiState.completed)
                              ScheduleMessageCard(
                                key: const ValueKey('clock-status'),
                                title: 'Shift completed',
                                message: awaitingMetrics
                                    ? 'Updating worked time…'
                                    : null,
                                kind: ScheduleMessageKind.success,
                                actionLabel: 'Back to shifts',
                                onAction: () => Navigator.of(
                                  context,
                                ).popUntil((route) => route.isFirst),
                              )
                            else
                              Padding(
                                padding: const EdgeInsets.symmetric(
                                  vertical: 14,
                                ),
                                child: Text(
                                  status,
                                  key: const ValueKey('clock-status'),
                                  style: ScheduleTokens.body.copyWith(
                                    fontWeight: FontWeight.w600,
                                  ),
                                ),
                              ),
                            if (awaitingMetrics)
                              TextButton(
                                onPressed: attendance.isLoadingHistory
                                    ? null
                                    : attendance.loadHistory,
                                child: Text(
                                  attendance.isLoadingHistory
                                      ? 'Refreshing…'
                                      : 'Refresh worked time',
                                ),
                              ),
                          ],
                        ),
                      ),
                    ),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

Widget _field(String label, String value) => Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    Text(
      label,
      style: ScheduleTokens.label.copyWith(fontSize: 10, letterSpacing: .6),
    ),
    const SizedBox(height: 2),
    Text(
      value,
      style: ScheduleTokens.body.copyWith(fontWeight: FontWeight.w600),
    ),
  ],
);
Widget _member(String name, ShiftVisualStyle style) => Row(
  children: [
    const Expanded(child: Text('Team Member', style: ScheduleTokens.label)),
    ScheduleAvatarStack(names: [name]),
  ],
);
Widget _clockButton(
  String label,
  VoidCallback? onPressed, {
  bool busy = false,
  Key? key,
}) => SchedulePrimaryButton(
  key: key,
  label: label,
  onPressed: onPressed,
  busy: busy,
  icon: Icons.watch_later_outlined,
);

/// Only this small subtree ticks. Values always derive from timestamps, never a local counter.
class ClockShiftTimer extends StatefulWidget {
  const ClockShiftTimer({
    super.key,
    this.startsAt,
    this.endsAt,
    this.attendance,
    required this.live,
    required this.completed,
    required this.status,
    required this.visualStyle,
  });
  final DateTime? startsAt, endsAt;
  final AttendanceSummary? attendance;
  final bool live, completed;
  final String status;
  final ShiftVisualStyle visualStyle;
  @override
  State<ClockShiftTimer> createState() => _ClockShiftTimerState();
}

class _ClockShiftTimerState extends State<ClockShiftTimer> {
  late final Timer _tick = Timer.periodic(const Duration(seconds: 1), (_) {
    if (mounted && TickerMode.of(context)) setState(() {});
  });
  @override
  void initState() {
    super.initState();
    _tick;
  }

  @override
  void dispose() {
    _tick.cancel();
    super.dispose();
  }

  String _hhmm(Duration duration) {
    final minutes = math.max(0, duration.inMinutes);
    return '${(minutes ~/ 60).toString().padLeft(2, '0')}:${(minutes % 60).toString().padLeft(2, '0')}';
  }

  @override
  Widget build(BuildContext context) {
    final now =
        context.read<AttendanceProvider>().trustedNow ??
        widget.attendance?.clockInAt ??
        widget.startsAt ??
        DateTime.fromMillisecondsSinceEpoch(0);
    final duration = widget.startsAt == null || widget.endsAt == null
        ? null
        : widget.endsAt!.difference(widget.startsAt!);
    final worked = widget.attendance == null
        ? null
        : widget.completed
        ? widget.attendance!.workedMinutes != null
              ? Duration(minutes: widget.attendance!.workedMinutes!)
              : null
        : now.difference(widget.attendance!.clockInAt);
    final remaining = widget.endsAt == null
        ? null
        : widget.completed
        ? Duration.zero
        : now.isBefore(widget.startsAt!)
        ? duration
        : widget.endsAt!.difference(now);
    final minutes = duration?.inMinutes;
    final big = widget.live || widget.completed
        ? (worked == null ? '—' : _hhmm(worked))
        : minutes == null
        ? '—'
        : minutes % 60 == 0
        ? '${minutes ~/ 60}H'
        : '${minutes ~/ 60}H${minutes % 60}M';
    final scale = MediaQuery.textScalerOf(context).scale(14) / 14;
    return Container(
      key: const ValueKey('clock-timer-ring'),
      width: 196 * scale.clamp(1, 1.5),
      height: 196 * scale.clamp(1, 1.5),
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: widget.visualStyle.clockRing, width: 4),
      ),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Text(
            widget.live
                ? 'LIVE SHIFT'
                : widget.completed
                ? 'COMPLETED'
                : 'YOUR SHIFT',
            style: ScheduleTokens.label.copyWith(
              fontSize: 10,
              letterSpacing: 1,
            ),
          ),
          const SizedBox(height: 8),
          Text(
            big,
            key: const ValueKey('clock-timer-value'),
            style: const TextStyle(
              fontSize: 40,
              fontWeight: FontWeight.w300,
              height: 1.1,
              color: ScheduleTokens.ink,
            ),
          ),
          const SizedBox(height: 10),
          Text(
            widget.live || widget.completed ? 'TIME WORKED' : 'TIME REMAINING',
            style: ScheduleTokens.label.copyWith(
              fontSize: 9,
              letterSpacing: .8,
            ),
          ),
          Text(
            remaining == null
                ? '—'
                : '${_hhmm(remaining)}${widget.live ? ' remaining' : ''}',
            style: ScheduleTokens.label.copyWith(fontSize: 12),
          ),
          const SizedBox(height: 8),
          Text(
            '• ${widget.status}',
            textAlign: TextAlign.center,
            style: ScheduleTokens.label.copyWith(fontSize: 10),
          ),
        ],
      ),
    );
  }
}
