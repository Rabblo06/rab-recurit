import 'dart:math' as math;
import 'dart:ui' show lerpDouble;
import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import '../../../core/models/offer.dart';
import '../../../core/motion/shift_motion.dart';
import '../../../core/theme/tokens.dart';
import '../../../core/theme/schedule_tokens.dart';
import '../../../core/theme/shift_visual_style.dart';
import '../../offers/schedule_offer_detail_screen.dart';
import 'upcoming_shift_card.dart';

/// Nonopaque routes keep the source dashboard mounted and stationary.
/// Reverse uses the same rects; Navigator handles Android/system back.
Route<void> shiftDetailRoute(
  BuildContext context,
  OfferSummary offer,
  Rect source, {
  bool schedule = false,
  ShiftVisualStyle? visualStyle,
  bool homeLayout = false,
}) {
  final reduced = ShiftMotion.reduced(context);
  // Capture the source's style once; reverse uses the same route argument.
  final selectedStyle = visualStyle ?? ShiftVisualStyle.forShift(offer.shiftId);
  if (schedule) {
    return pastelDetailRoute(
      source: source,
      style: selectedStyle,
      reduced: reduced,
      name: '/shift/${offer.shiftId}',
      page: ScheduleOfferDetailScreen(offer: offer, visualStyle: selectedStyle),
      sourceCard: UpcomingShiftCard(
        offer: offer,
        schedule: true,
        homeLayout: homeLayout,
        visualStyle: selectedStyle,
      ),
    );
  }
  return PageRouteBuilder<void>(
    settings: RouteSettings(name: '/shift/${offer.shiftId}'),
    opaque: false,
    transitionDuration: reduced ? Duration.zero : ShiftMotion.expansion,
    reverseTransitionDuration: reduced ? Duration.zero : ShiftMotion.expansion,
    pageBuilder: (context, animation, secondary) => AnimatedBuilder(
      animation: animation,
      builder: (context, _) {
        final p = reduced
            ? 1.0
            : Curves.easeOutCubic.transform(animation.value);
        final size = MediaQuery.sizeOf(context);
        final rect = Rect.lerp(source, Offset.zero & size, p)!;
        final reveal = ((p - .65) / .35).clamp(0.0, 1.0);
        final headerHeight = UpcomingShiftCard.heightFor(
          context,
          schedule: schedule,
        );
        final headerTop =
            MediaQuery.paddingOf(context).top + kToolbarHeight + 16;
        return Stack(
          children: [
            Positioned.fromRect(
              rect: rect,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(
                  HomeGeometry.cardRadius * (1 - p),
                ),
                child: Material(
                  color: schedule
                      ? Color.lerp(selectedStyle.card, selectedStyle.page, p)
                      : context.colors.bgApp,
                  child: Stack(
                    children: [
                      OverflowBox(
                        alignment: Alignment.topLeft,
                        minWidth: size.width,
                        maxWidth: size.width,
                        minHeight: size.height,
                        maxHeight: size.height,
                        child: Opacity(
                          opacity: reveal,
                          child: SizedBox.fromSize(
                            size: size,
                            // Schedule's detail screen is a full new-theme
                            // page (§9) with no shared-element header slot to
                            // fill — the outer Positioned.fromRect/ClipRRect
                            // above already carries the "card grows into the
                            // page" continuity for it. Classic keeps the
                            // pinned-card header it already had.
                            // Schedule is the only UI style now — this
                            // non-`schedule` branch of `shiftDetailRoute`
                            // is unreachable in practice (every caller
                            // passes `schedule: true`), kept only because
                            // this route/animation plumbing is otherwise
                            // untouched per "preserve Schedule UI exactly."
                            child: ScheduleOfferDetailScreen(
                              offer: offer,
                              visualStyle: selectedStyle,
                            ),
                          ),
                        ),
                      ),
                      if (p < 1)
                        Positioned(
                          top: headerTop * p,
                          left: 16 * p,
                          right: 16 * p,
                          height:
                              source.height +
                              (headerHeight - source.height) * p,
                          child: UpcomingShiftCard(
                            offer: offer,
                            schedule: schedule,
                            visualStyle: schedule ? selectedStyle : null,
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
  );
}

/// The first/last 100 ms belong to source content, at its original bounds.
/// Between those phases only the coloured surface changes bounds; a second
/// card never travels to the detail header.
Route<void> pastelDetailRoute({
  required Rect source,
  required ShiftVisualStyle style,
  required bool reduced,
  required String name,
  required Widget page,
  required Widget sourceCard,
  Color? sourceColor,
}) => PageRouteBuilder<void>(
  settings: RouteSettings(name: name),
  opaque: false,
  transitionDuration: Duration(milliseconds: reduced ? 140 : 500),
  reverseTransitionDuration: Duration(milliseconds: reduced ? 140 : 500),
  pageBuilder: (context, animation, secondary) => AnimatedBuilder(
    animation: animation,
    builder: (context, _) {
      final t = animation.value;
      final surface = Curves.easeInOutCubic.transform(
        ((t - .2) / .8).clamp(0.0, 1.0),
      );
      final sourceContent = (1 - t / .2).clamp(0.0, 1.0);
      final detailContent = reduced ? t : ((t - .64) / .36).clamp(0.0, 1.0);
      final size = MediaQuery.sizeOf(context);
      final rect = reduced
          ? Offset.zero & size
          : Rect.lerp(source, Offset.zero & size, surface)!;
      final detail = SizedBox.fromSize(size: size, child: page);
      return Opacity(
        opacity: reduced ? t : 1,
        child: Stack(
          children: [
            Positioned.fromRect(
              key: const ValueKey('detail-expansion-surface'),
              rect: rect,
              child: IgnorePointer(
                ignoring: animation.status != AnimationStatus.completed,
                child: ClipRRect(
                  borderRadius: BorderRadius.circular(
                    reduced ? 0 : ScheduleTokens.cardRadius * (1 - surface),
                  ),
                  child: RepaintBoundary(
                    child: Material(
                      color: Color.lerp(
                        sourceColor ?? style.card,
                        style.card,
                        surface,
                      ),
                      child: Stack(
                        children: [
                          if (!reduced && sourceContent > 0)
                            Opacity(
                              key: const ValueKey('detail-source-content'),
                              opacity: sourceContent,
                              child: SizedBox.fromSize(
                                size: source.size,
                                child: sourceCard,
                              ),
                            ),
                          OverflowBox(
                            alignment: Alignment.topLeft,
                            minWidth: size.width,
                            maxWidth: size.width,
                            minHeight: size.height,
                            maxHeight: size.height,
                            child: Transform.translate(
                              // Detail stays at viewport coordinates as the
                              // surface clip expands around it.
                              offset: Offset(-rect.left, -rect.top),
                              child: Opacity(
                                key: const ValueKey('detail-content-entrance'),
                                opacity: detailContent,
                                child: reduced
                                    ? Transform.scale(
                                        scale: .99 + .01 * t,
                                        child: detail,
                                      )
                                    : detail,
                              ),
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    },
  ),
);

Route<void> upcomingListRoute(
  BuildContext context,
  List<OfferSummary> offers,
  List<Rect> sources, {
  bool schedule = false,
}) {
  final reduced = ShiftMotion.reduced(context);
  return PageRouteBuilder<void>(
    settings: const RouteSettings(name: '/upcoming-shifts'),
    opaque: false,
    transitionDuration: reduced ? Duration.zero : ShiftMotion.expansion,
    reverseTransitionDuration: reduced ? Duration.zero : ShiftMotion.expansion,
    pageBuilder: (_, animation, secondary) => _ExpandedShifts(
      offers: offers,
      sources: sources,
      animation: animation,
      reduced: reduced,
      schedule: schedule,
    ),
  );
}

class _ExpandedShifts extends StatefulWidget {
  const _ExpandedShifts({
    required this.offers,
    required this.sources,
    required this.animation,
    required this.reduced,
    required this.schedule,
  });
  final List<OfferSummary> offers;
  final List<Rect> sources;
  final Animation<double> animation;
  final bool reduced;
  final bool schedule;
  @override
  State<_ExpandedShifts> createState() => _ExpandedShiftsState();
}

class _ExpandedShiftsState extends State<_ExpandedShifts> {
  final _scroll = ScrollController();
  String? _opening;
  Drag? _drag;
  @override
  void dispose() {
    _drag?.cancel();
    _scroll.dispose();
    super.dispose();
  }

  Future<void> _detail(
    OfferSummary offer,
    Rect rect,
    ShiftVisualStyle visualStyle,
  ) async {
    if (_opening != null ||
        widget.animation.status != AnimationStatus.completed) {
      return;
    }
    setState(() => _opening = offer.id);
    final route = shiftDetailRoute(
      context,
      offer,
      rect,
      schedule: widget.schedule,
      visualStyle: visualStyle,
    );
    await Navigator.of(context).push(route);
    await (route as TransitionRoute<void>).completed;
    if (mounted) setState(() => _opening = null);
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: Listenable.merge([widget.animation, _scroll]),
    builder: (context, _) {
      final size = MediaQuery.sizeOf(context);
      final top = MediaQuery.paddingOf(context).top + 64;
      final h = UpcomingShiftCard.heightFor(context, schedule: widget.schedule);
      final offset = _scroll.hasClients ? _scroll.offset : 0.0;
      final p = widget.reduced ? 1.0 : widget.animation.value;
      final ready = widget.animation.status == AnimationStatus.completed;
      final rects = <int, Rect>{};
      // Build only visible cards plus the source stack during transitions.
      for (var i = 0; i < widget.offers.length; i++) {
        final y = top + i * (h + 16) - offset;
        if (ready && (y + h < top - 2 * h || y > size.height + h)) continue;
        if (!ready && i > 3 && (y + h < top - 2 * h || y > size.height + h)) {
          continue;
        }
        final compression = widget.reduced
            ? 0.0
            : ((top - y) / h).clamp(0.0, 1.0);
        final scale = 1 - compression * .03;
        final target = Rect.fromLTWH(
          16 + (size.width - 32) * (1 - scale) / 2,
          math.max(y, top - compression * 12),
          (size.width - 32) * scale,
          h * scale,
        );
        final local = widget.reduced
            ? 1.0
            : ((p - math.min(i, 2) * .065) / (1 - math.min(i, 2) * .065)).clamp(
                0.0,
                1.0,
              );
        rects[i] = Rect.lerp(
          widget.sources[i],
          target,
          Curves.easeOutCubic.transform(local),
        )!;
      }
      return Material(
        type: MaterialType.transparency,
        child: Stack(
          children: [
            Positioned.fill(
              child: Opacity(
                opacity: p,
                child: ColoredBox(color: context.colors.bgApp),
              ),
            ),
            Positioned.fill(
              top: top,
              child: SingleChildScrollView(
                controller: _scroll,
                child: SizedBox(height: widget.offers.length * (h + 16) + 48),
              ),
            ),
            // Later cards paint above compressed earlier cards when scrolling;
            // reverse order while opening reproduces the collapsed deck layering.
            for (final i
                in (ready && offset > 0
                    ? rects.keys
                    : rects.keys.toList().reversed))
              Positioned.fromRect(
                rect: rects[i]!,
                child: IgnorePointer(
                  ignoring: !ready || _opening != null,
                  child: ExcludeSemantics(
                    excluding: !ready || rects[i]!.top < top - 1,
                    child: Opacity(
                      opacity: _opening == widget.offers[i].id
                          ? 0
                          : (i > 2 ? p : (1 - i * .18) + i * .18 * p),
                      child: GestureDetector(
                        onVerticalDragStart: ready
                            ? (d) {
                                _drag = _scroll.position.drag(
                                  d,
                                  () => _drag = null,
                                );
                              }
                            : null,
                        onVerticalDragUpdate: (d) => _drag?.update(d),
                        onVerticalDragEnd: (d) {
                          _drag?.end(d);
                          _drag = null;
                        },
                        onVerticalDragCancel: () {
                          _drag?.cancel();
                          _drag = null;
                        },
                        child: FittedBox(
                          fit: BoxFit.fill,
                          child: SizedBox(
                            width: size.width - 32,
                            height: h,
                            // Identity colour is unchanged throughout expansion.
                            child: Builder(
                              builder: (context) {
                                final visibleStyle = ShiftVisualStyle.forShift(
                                  widget.offers[i].shiftId,
                                );
                                return UpcomingShiftCard(
                                  schedule: widget.schedule,
                                  visualStyle: widget.schedule
                                      ? visibleStyle
                                      : null,
                                  key: ValueKey(
                                    'expanded-${widget.offers[i].id}',
                                  ),
                                  offer: widget.offers[i],
                                  materialDepth: widget.schedule
                                      ? lerpDouble(
                                          i.clamp(0, 2).toDouble(),
                                          (i % 3).toDouble(),
                                          p,
                                        )!
                                      : i.clamp(0, 2) * (1 - p),
                                  contentOpacity: i == 0 ? 1 : p,
                                  onOpen: () => _detail(
                                    widget.offers[i],
                                    rects[i]!,
                                    visibleStyle,
                                  ),
                                );
                              },
                            ),
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              height: top,
              child: Opacity(
                opacity: p,
                child: ColoredBox(
                  color: context.colors.bgApp,
                  child: SafeArea(
                    bottom: false,
                    child: Row(
                      children: [
                        BackButton(
                          onPressed: () => Navigator.of(context).maybePop(),
                        ),
                        Text('Upcoming Shifts', style: context.text.section),
                      ],
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      );
    },
  );
}
