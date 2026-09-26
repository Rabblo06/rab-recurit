import 'dart:math' as math;
import 'dart:ui' show lerpDouble;
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/physics.dart';
import '../../../core/models/offer.dart';
import '../../../core/motion/shift_motion.dart';
import '../../../core/theme/tokens.dart';
import '../../../core/theme/schedule_tokens.dart';
import '../../../core/theme/shift_visual_style.dart';
import 'shift_routes.dart';
import 'upcoming_shift_card.dart';

enum _DeckPhase { idle, dragging, snapping, openingDetail, expandingAll }

class UpcomingShiftDeck extends StatefulWidget {
  const UpcomingShiftDeck({
    super.key,
    required this.offers,
    this.cardHeight,
    this.loading = false,
    this.schedule = false,
    this.title,
    this.cardBuilder,
    this.routeBuilder,
  });
  final List<ShiftDeckRecord> offers;
  final String? title;
  final Widget Function(
    ShiftDeckRecord record,
    ShiftVisualStyle style,
    double opacity,
    VoidCallback? onOpen,
  )?
  cardBuilder;
  final Route<void> Function(
    ShiftDeckRecord record,
    Rect source,
    ShiftVisualStyle style,
    bool all,
  )?
  routeBuilder;
  final double? cardHeight;
  final bool loading;
  final bool schedule;
  @override
  State<UpcomingShiftDeck> createState() => _UpcomingShiftDeckState();
}

class _UpcomingShiftDeckState extends State<UpcomingShiftDeck>
    with SingleTickerProviderStateMixin {
  double get _frontY => widget.schedule ? 22 : HomeGeometry.stackFront;
  double get _gap => widget.schedule ? 8 : HomeGeometry.stackGap;
  static const _scaleStep = HomeGeometry.stackScale;
  late final AnimationController _offset = AnimationController.unbounded(
    vsync: this,
  );
  final _surfaces = <String, GlobalKey>{};
  int _index = 0;
  _DeckPhase _phase = _DeckPhase.idle;
  bool _hidden = false;
  double _raw = 0;
  bool get _idle => _phase == _DeckPhase.idle;
  double get _height =>
      widget.cardHeight ??
      UpcomingShiftCard.heightFor(context, schedule: widget.schedule);
  double get _exitDistance => _height + 80;
  int _wrap(int index) => index % widget.offers.length;

  @override
  void initState() {
    super.initState();
    _offset.value = 0;
  }

  @override
  void didUpdateWidget(UpcomingShiftDeck old) {
    super.didUpdateWidget(old);
    final before = old.offers.map((o) => o.id).toList();
    final after = widget.offers.map((o) => o.id).toList();
    if (listEquals(before, after)) return;
    final id = before.isEmpty
        ? null
        : before[_index.clamp(0, before.length - 1)];
    final next = after.indexOf(id ?? '');
    _index = next < 0 ? 0 : next;
    _surfaces.removeWhere((id, _) => !after.contains(id));
    _cancelSettle();
  }

  void _cancelSettle() {
    if (_phase != _DeckPhase.dragging && _phase != _DeckPhase.snapping) return;
    _offset.stop();
    _offset.value = 0;
    _raw = 0;
    _phase = _DeckPhase.idle;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (!TickerMode.of(context)) _cancelSettle();
  }

  @override
  void dispose() {
    _offset.dispose();
    super.dispose();
  }

  void _start(DragStartDetails details) {
    if (!_idle) return;
    _raw = 0;
    setState(() => _phase = _DeckPhase.dragging);
  }

  void _update(DragUpdateDetails details) {
    if (_phase != _DeckPhase.dragging) return;
    _raw += details.delta.dy;
    // A held card cannot change paint order before release. Beyond its exit
    // distance, resistance bounds travel; one real card always resists.
    final distance = widget.offers.length < 2 ? _raw * .24 : _raw;
    final limit = _exitDistance * .95;
    final bounded = distance.abs() <= limit
        ? distance
        : distance.sign *
              (limit +
                  (_exitDistance * .04) *
                      (1 - math.exp(-(distance.abs() - limit) / 80)));
    _offset.value = ShiftMotion.reduced(context) ? 0 : bounded;
  }

  Future<void> _settle(
    double velocity, {
    bool cancel = false,
    int? step,
  }) async {
    if (step != null ? !_idle : _phase != _DeckPhase.dragging) return;
    final direction =
        step ??
        (velocity.abs() > 550 ? (velocity < 0 ? 1 : -1) : (_raw < 0 ? 1 : -1));
    final commit =
        !cancel &&
        widget.offers.length > 1 &&
        (step != null || _raw.abs() > 64 || velocity.abs() > 550);
    setState(() => _phase = _DeckPhase.snapping);
    try {
      if (!ShiftMotion.reduced(context)) {
        if (commit) {
          // First half clears the stack. Only then does the outgoing card
          // pass behind the other cards and return to its new slot.
          await _offset
              .animateTo(
                -direction * _exitDistance * 2,
                duration: Duration(
                  milliseconds: velocity.abs() > 1100 ? 300 : 360,
                ),
                curve: Curves.easeInOutCubic,
              )
              .orCancel;
        } else {
          await _offset
              .animateWith(
                SpringSimulation(
                  ShiftMotion.settle,
                  _offset.value,
                  0,
                  velocity.clamp(-1500, 1500),
                  tolerance: const Tolerance(distance: .5, velocity: 1),
                ),
              )
              .orCancel;
        }
      }
      if (!mounted) return;
      setState(() {
        if (commit) _index = _wrap(_index + direction);
        _offset.value = 0;
        _raw = 0;
        _phase = _DeckPhase.idle;
      });
    } on TickerCanceled {
      /* tab change, data refresh, or disposal */
    }
  }

  Rect _rect() {
    final box =
        _surfaces[widget.offers[_index].id]!.currentContext!.findRenderObject()!
            as RenderBox;
    return MatrixUtils.transformRect(
      box.getTransformTo(null),
      Offset.zero & box.size,
    );
  }

  Future<void> _open(bool all, {ShiftVisualStyle? visualStyle}) async {
    if (!_idle || widget.offers.isEmpty) return;
    final selected = widget.offers[_index];
    final originalRect = _rect();
    final stationaryDetail = widget.schedule && !all;
    setState(
      () => _phase = all ? _DeckPhase.expandingAll : _DeckPhase.openingDetail,
    );
    try {
      if (!stationaryDetail && !ShiftMotion.reduced(context)) {
        await _offset
            .animateTo(
              -8,
              duration: const Duration(milliseconds: 100),
              curve: Curves.easeOutCubic,
            )
            .orCancel;
      }
      if (!mounted) return;
      if (widget.offers.isEmpty) {
        setState(() {
          _offset.value = 0;
          _phase = _DeckPhase.idle;
        });
        return;
      }
      final source = stationaryDetail ? originalRect : _rect();
      final ordered = [
        ...widget.offers.skip(_index),
        ...widget.offers.take(_index),
      ];
      final sources = List.generate(ordered.length, (i) {
        final depth = math.min(i, 2);
        return Rect.fromLTWH(
          source.left + source.width * depth * _scaleStep / 2,
          source.top - depth * _gap,
          source.width * (1 - depth * _scaleStep),
          source.height * (1 - depth * _scaleStep),
        );
      });
      final route =
          widget.routeBuilder?.call(
            selected,
            source,
            visualStyle ?? ShiftVisualStyle.forShift(selected.shiftId),
            all,
          ) ??
          (all
              ? upcomingListRoute(
                  context,
                  ordered.cast<OfferSummary>(),
                  sources,
                  schedule: widget.schedule,
                )
              : shiftDetailRoute(
                  context,
                  selected as OfferSummary,
                  source,
                  schedule: widget.schedule,
                  visualStyle: visualStyle,
                  homeLayout: widget.schedule,
                ));
      final navigation = Navigator.of(context).push(route);
      final transition = route as TransitionRoute<void>;
      void restoreSource(AnimationStatus status) {
        // Restore in the final animation frame, before Navigator removes its
        // overlay. Waiting for completed alone leaves one blank source frame.
        if (status == AnimationStatus.dismissed && mounted) {
          setState(() => _hidden = false);
        }
      }

      transition.animation?.addStatusListener(restoreSource);
      // Navigator inserts the route overlay on the next frame. Keep the
      // source painted until that frame exists, avoiding an empty handoff.
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted &&
            transition.animation?.status != AnimationStatus.dismissed) {
          setState(() => _hidden = true);
        }
      });
      await navigation;
      await transition.completed;
      transition.animation?.removeStatusListener(restoreSource);
      if (!mounted) return;
      // Keep input locked through the return lift, too.
      setState(() => _hidden = false);
      if (!stationaryDetail && !ShiftMotion.reduced(context)) {
        await _offset
            .animateTo(
              0,
              duration: const Duration(milliseconds: 100),
              curve: Curves.easeOutCubic,
            )
            .orCancel;
      } else {
        _offset.value = 0;
      }
      if (mounted) setState(() => _phase = _DeckPhase.idle);
    } on TickerCanceled {
      /* disposed while opening or returning */
    }
  }

  List<_Slot> _slots() {
    final count = widget.offers.length;
    final opening =
        _phase == _DeckPhase.openingDetail || _phase == _DeckPhase.expandingAll;
    final delta = _offset.value;
    final direction = delta <= 0 ? 1 : -1;
    final progress = opening || count < 2
        ? 0.0
        : (delta.abs() / (_exitDistance * 2)).clamp(0.0, 1.0);
    final advance = (progress * 2).clamp(0.0, 1.0);
    final returning = ((progress - .5) * 2).clamp(0.0, 1.0);
    final next = _wrap(_index + direction);
    final indices = <int>{
      for (var i = 0; i < math.min(count, 3); i++) _wrap(_index + i),
    };
    if (progress > 0) {
      if (widget.schedule && progress >= .5) indices.clear();
      for (var i = 0; i < math.min(count, 3); i++) {
        if (!widget.schedule || progress >= .5) indices.add(_wrap(next + i));
      }
    }
    final result = <_Slot>[];
    for (final index in indices) {
      final oldDepth = _wrap(index - _index).toDouble();
      final targetDepth = _wrap(index - next).toDouble();
      var depth = math.min(oldDepth, 3.0);
      var y = _frontY - depth * _gap;
      var z = depth;
      if (opening) {
        y += delta;
      } else if (index == _index) {
        if (progress <= .5) {
          y = _frontY + delta;
          depth = advance * .2;
          z = -1;
        } else {
          final target = math.min(targetDepth, 3.0);
          depth = lerpDouble(
            .2,
            target,
            Curves.easeOutCubic.transform(returning),
          )!;
          y = lerpDouble(
            _frontY - direction * _exitDistance,
            _frontY - target * _gap,
            Curves.easeOutCubic.transform(returning),
          )!;
          z = target;
        }
      } else {
        depth = lerpDouble(
          math.min(oldDepth, 3.0),
          math.min(targetDepth, 3.0),
          advance,
        )!;
        y = _frontY - depth * _gap;
        z = depth;
      }
      result.add(_Slot(index, depth, y, z));
    }
    result.sort((a, b) => b.z.compareTo(a.z));
    return result;
  }

  @override
  Widget build(BuildContext context) {
    ShiftVisualStyle.registerGroup(widget.offers.map((offer) => offer.shiftId));
    final h = _height;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Padding(
          padding: EdgeInsets.only(left: widget.schedule ? 0 : 8, right: 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  widget.title ??
                      (widget.schedule ? 'Upcoming Shift' : 'Upcoming Shifts'),
                  style: widget.schedule
                      ? ScheduleTokens.heading
                      : context.text.section,
                ),
              ),
              MotionPress(
                label: 'View all upcoming shifts',
                onPressed: _idle && widget.offers.isNotEmpty
                    ? () => _open(true)
                    : null,
                child: Text(
                  'view all  ›',
                  style: context.text.label.copyWith(fontSize: 10),
                ),
              ),
            ],
          ),
        ),
        if (widget.offers.isEmpty)
          Container(
            key: const ValueKey('upcoming-empty'),
            height: h,
            margin: const EdgeInsets.only(top: 24),
            padding: const EdgeInsets.all(26),
            decoration: BoxDecoration(
              color: widget.schedule ? ScheduleTokens.lavender : null,
              gradient: widget.schedule ? null : HomePalette.cardGradient,
              borderRadius: BorderRadius.circular(HomeGeometry.cardRadius),
              boxShadow: HomeGeometry.cardShadow,
            ),
            child: Align(
              alignment: Alignment.topLeft,
              child: Text(
                widget.loading
                    ? 'Loading upcoming shifts…'
                    : 'No upcoming confirmed shifts.',
                style: context.text.section.copyWith(
                  color: widget.schedule
                      ? ScheduleTokens.ink
                      : context.colors.onDarkPrimary,
                ),
              ),
            ),
          )
        else
          Semantics(
            label: 'Upcoming shift ${_index + 1} of ${widget.offers.length}',
            onIncrease: _idle && widget.offers.length > 1
                ? () => _settle(0, step: 1)
                : null,
            onDecrease: _idle && widget.offers.length > 1
                ? () => _settle(0, step: -1)
                : null,
            child: GestureDetector(
              key: const ValueKey('upcoming-deck'),
              behavior: HitTestBehavior.opaque,
              onVerticalDragStart: _start,
              onVerticalDragUpdate: _update,
              onVerticalDragEnd: (d) => _settle(d.primaryVelocity ?? 0),
              onVerticalDragCancel: () => _settle(0, cancel: true),
              child: SizedBox(
                height: h + _frontY + 8,
                child: ClipRect(
                  child: AnimatedBuilder(
                    animation: _offset,
                    builder: (context, _) {
                      final slots = _slots();
                      return Stack(
                        clipBehavior: Clip.none,
                        children: [
                          for (final slot in slots)
                            Positioned(
                              key: ValueKey(
                                'deck-card-${widget.offers[slot.index].id}',
                              ),
                              left: 0,
                              right: 0,
                              top: 0,
                              height: h,
                              child: Transform.translate(
                                offset: Offset(0, slot.y),
                                child: Transform.scale(
                                  alignment: Alignment.topCenter,
                                  scale: 1 - slot.depth * _scaleStep,
                                  child: IgnorePointer(
                                    ignoring: slot.index != _index || !_idle,
                                    child: ExcludeSemantics(
                                      excluding:
                                          slot.index != _index || _hidden,
                                      child: Opacity(
                                        key: ValueKey(
                                          'deck-layer-${widget.offers[slot.index].id}',
                                        ),
                                        // The route owns the whole source surface
                                        // during the handoff. Leaving the full rear
                                        // cards painted exposes them through the
                                        // route's rounded/fading edges on tap/back.
                                        opacity:
                                            _hidden &&
                                                (widget.schedule ||
                                                    _phase ==
                                                        _DeckPhase
                                                            .expandingAll ||
                                                    slot.index == _index)
                                            ? 0
                                            : ((3 - slot.depth).clamp(
                                                        0.0,
                                                        1.0,
                                                      ) *
                                                      (1 - slot.depth * .18))
                                                  .clamp(0.0, 1.0),
                                        child: SizedBox(
                                          key: _surfaces.putIfAbsent(
                                            widget.offers[slot.index].id,
                                            GlobalKey.new,
                                          ),
                                          child:
                                              widget.cardBuilder?.call(
                                                widget.offers[slot.index],
                                                ShiftVisualStyle.forShift(
                                                  widget
                                                      .offers[slot.index]
                                                      .shiftId,
                                                ),
                                                (1 - slot.depth).clamp(
                                                  0.0,
                                                  1.0,
                                                ),
                                                slot.index == _index && _idle
                                                    ? () => _open(
                                                        false,
                                                        visualStyle:
                                                            ShiftVisualStyle.forShift(
                                                              widget
                                                                  .offers[slot
                                                                      .index]
                                                                  .shiftId,
                                                            ),
                                                      )
                                                    : null,
                                              ) ??
                                              UpcomingShiftCard(
                                                homeLayout: widget.schedule,
                                                schedule: widget.schedule,
                                                offer:
                                                    widget.offers[slot.index]
                                                        as OfferSummary,
                                                visualStyle: widget.schedule
                                                    ? ShiftVisualStyle.forShift(
                                                        widget
                                                            .offers[slot.index]
                                                            .shiftId,
                                                      )
                                                    : null,
                                                materialDepth: slot.depth,
                                                contentOpacity: (1 - slot.depth)
                                                    .clamp(0.0, 1.0),
                                                onOpen:
                                                    slot.index == _index &&
                                                        _idle
                                                    ? () => _open(
                                                        false,
                                                        visualStyle:
                                                            widget.schedule
                                                            ? ShiftVisualStyle.forShift(
                                                                widget
                                                                    .offers[slot
                                                                        .index]
                                                                    .shiftId,
                                                              )
                                                            : null,
                                                      )
                                                    : null,
                                              ),
                                        ),
                                      ),
                                    ),
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
            ),
          ),
      ],
    );
  }
}

class _Slot {
  const _Slot(this.index, this.depth, this.y, this.z);
  final int index;
  final double depth, y, z;
}
