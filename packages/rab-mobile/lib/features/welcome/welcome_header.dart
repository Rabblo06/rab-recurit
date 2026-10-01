import 'dart:async';
import 'package:flutter/material.dart';
import 'onboarding_motion.dart';
import 'onboarding_auth_motion.dart';
import 'onboarding_page.dart';

/// Presentation only. The owning auth shell retains completion and navigation.
class WelcomeOnboarding extends StatefulWidget {
  const WelcomeOnboarding({
    super.key,
    required this.onGetStarted,
    this.authProgress = const AlwaysStoppedAnimation(0),
    this.active = true,
    this.transparent = false,
  });
  final Animation<double> authProgress;
  final bool active;
  final bool transparent;
  final VoidCallback onGetStarted;

  @override
  State<WelcomeOnboarding> createState() => _WelcomeOnboardingState();
}

class _WelcomeOnboardingState extends State<WelcomeOnboarding>
    with SingleTickerProviderStateMixin, WidgetsBindingObserver {
  final _pages = PageController(initialPage: 3000, viewportFraction: 1.0);
  Timer? _advance;
  int _virtualPage = 3000;
  final Set<int> _pointers = {};
  bool _scrolling = false;
  bool _foreground = true;
  bool _finished = false;
  bool _reduced = false;
  late final AnimationController _entrance;
  int _current = 0;
  bool _prepared = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    _entrance = AnimationController(
      vsync: this,
      duration: OnboardingMotion.entrance,
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _reduced = MediaQuery.disableAnimationsOf(context);
    if (_reduced) _entrance.value = 1;
    _scheduleAdvance();
    if (_prepared) return;
    _prepared = true;
    for (final image in [
      OnboardingPhotos.reception,
      OnboardingPhotos.housekeeping,
      OnboardingPhotos.dining,
    ]) {
      precacheImage(image, context);
    }
    if (!MediaQuery.disableAnimationsOf(context)) _entrance.forward();
  }

  @override
  void didUpdateWidget(WelcomeOnboarding oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.active) {
      _advance?.cancel();
      if (_pages.hasClients) _pages.jumpTo(_pages.position.pixels);
    } else if (!oldWidget.active) {
      _finished = false;
      if (_pages.hasClients &&
          ((_pages.page ?? _virtualPage.toDouble()) - _virtualPage).abs() >
              .001) {
        _animateTo(_virtualPage);
      } else {
        _scheduleAdvance();
      }
    }
  }

  @override
  void dispose() {
    _advance?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _pages.dispose();
    _entrance.dispose();
    super.dispose();
  }

  void _scheduleAdvance() {
    _advance?.cancel();
    if (!mounted ||
        _finished ||
        !widget.active ||
        _reduced ||
        !_foreground ||
        _pointers.isNotEmpty ||
        _scrolling ||
        !TickerMode.of(context)) {
      return;
    }
    _advance = Timer(OnboardingMotion.hold, () {
      if (mounted && _pages.hasClients) _animateTo(_virtualPage + 1);
    });
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    _foreground = state == AppLifecycleState.resumed;
    _scheduleAdvance();
  }

  Future<void> _animateTo(int page) async {
    _advance?.cancel();
    if (!_pages.hasClients) return;
    if (_reduced) {
      _pages.jumpToPage(page);
    } else {
      await _pages.animateToPage(
        page,
        duration: OnboardingMotion.pageTransition,
        curve: OnboardingMotion.pageCurve,
      );
    }
    if (mounted) _scheduleAdvance();
  }

  void _goTo(int index) {
    var delta = index - _current;
    if (delta == 2) delta = -1;
    if (delta == -2) delta = 1;
    _animateTo(_virtualPage + delta);
  }

  void _finish() {
    _finished = true;
    _advance?.cancel();
    if (_pages.hasClients) _pages.jumpTo(_pages.position.pixels);
    widget.onGetStarted();
  }

  Widget _pageView() => Listener(
    onPointerDown: (event) {
      _pointers.add(event.pointer);
      _advance?.cancel();
    },
    onPointerUp: (event) {
      _pointers.remove(event.pointer);
      _scheduleAdvance();
    },
    onPointerCancel: (event) {
      _pointers.remove(event.pointer);
      _scheduleAdvance();
    },
    child: NotificationListener<ScrollNotification>(
      onNotification: (notification) {
        if (notification is ScrollStartNotification) {
          _scrolling = true;
          _advance?.cancel();
        } else if (notification is ScrollEndNotification) {
          _scrolling = false;
          _scheduleAdvance();
        }
        return false;
      },
      child: ClipRect(
        clipBehavior: Clip.hardEdge,
        child: PageView.builder(
          controller: _pages,
          clipBehavior: Clip.hardEdge,
          onPageChanged: (value) => setState(() {
            _virtualPage = value;
            _current = value % 3;
          }),
          itemBuilder: (context, virtualIndex) => ClipRect(
            key: ValueKey('onboarding-page-$virtualIndex'),
            clipBehavior: Clip.hardEdge,
            child: OnboardingPage(
              index: virtualIndex % 3,
              virtualIndex: virtualIndex,
              controller: _pages,
              entrance: _entrance,
              authProgress: widget.authProgress,
            ),
          ),
        ),
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    final reduced = MediaQuery.disableAnimationsOf(context);
    return ColoredBox(
      color: widget.transparent ? Colors.transparent : onboardingCream,
      child: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 480),
            child: DefaultTextStyle(
              style: const TextStyle(
                color: onboardingInk,
                fontFamily: 'Roboto',
              ),
              child: Column(
                children: [
                  Padding(
                    padding: const EdgeInsets.only(left: 24, right: 10),
                    child: Row(
                      children: [
                        const Expanded(
                          child: Text(
                            'ADOLPHUS / RECRUITMENT',
                            style: TextStyle(
                              fontSize: 9,
                              letterSpacing: 1.1,
                              color: onboardingMuted,
                            ),
                          ),
                        ),
                        SizedBox(
                          width: 144,
                          height: 48,
                          child: OnboardingAuthPart(
                            progress: widget.authProgress,
                            child: Align(
                              alignment: Alignment.centerRight,
                              child: Padding(
                                padding: const EdgeInsets.only(right: 18),
                                child: Semantics(
                                  label: 'Onboarding page ${_current + 1} of 3',
                                  child: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: List.generate(
                                      3,
                                      (index) => Tooltip(
                                        message: [
                                          'Welcome',
                                          'Hospitality',
                                          'Opportunities',
                                        ][index],
                                        child: Semantics(
                                          selected: index == _current,
                                          child: InkWell(
                                            onTap: () => _goTo(index),
                                            borderRadius: BorderRadius.circular(
                                              2,
                                            ),
                                            child: Padding(
                                              padding:
                                                  const EdgeInsets.symmetric(
                                                    horizontal: 4,
                                                  ),
                                              child: SizedBox(
                                                height: 48,
                                                child: Center(
                                                  widthFactor: 1,
                                                  child: AnimatedContainer(
                                                    key: ValueKey(
                                                      'onboarding-indicator-$index',
                                                    ),
                                                    duration: reduced
                                                        ? Duration.zero
                                                        : OnboardingMotion
                                                              .indicator,
                                                    curve:
                                                        OnboardingMotion.curve,
                                                    width: index == _current
                                                        ? 18
                                                        : 4,
                                                    height: index == _current
                                                        ? 3
                                                        : 4,
                                                    decoration: BoxDecoration(
                                                      color: index == _current
                                                          ? onboardingInk
                                                          : const Color(
                                                              0xFFD2D1CA,
                                                            ),
                                                      borderRadius:
                                                          BorderRadius.circular(
                                                            2,
                                                          ),
                                                    ),
                                                  ),
                                                ),
                                              ),
                                            ),
                                          ),
                                        ),
                                      ),
                                    ),
                                  ),
                                ),
                              ),
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                  Expanded(
                    child: AnimatedBuilder(
                      animation: widget.authProgress,
                      child: _pageView(),
                      builder: (context, child) => Offstage(
                        offstage: widget.authProgress.value == 1,
                        child: child,
                      ),
                    ),
                  ),
                  Padding(
                    padding: EdgeInsets.only(
                      top: 12,
                      bottom: MediaQuery.sizeOf(context).height < 700 ? 16 : 48,
                    ),
                    child: OnboardingAuthPart(
                      progress: widget.authProgress,
                      child: OnboardingCta(onPressed: _finish),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}
