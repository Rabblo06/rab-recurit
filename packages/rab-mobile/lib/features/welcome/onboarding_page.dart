import 'package:flutter/material.dart';
import 'onboarding_motion.dart';
import 'onboarding_auth_motion.dart';

/// All photos are bundled locally. Decode bounds also apply to precaching.
abstract final class OnboardingPhotos {
  static const reception = ResizeImage(
    AssetImage('assets/onboarding/frontdesk.jpg'),
    width: 900,
  );
  static const housekeeping = ResizeImage(
    AssetImage('assets/onboarding/bedcleaning.jpg'),
    width: 700,
  );
  static const dining = ResizeImage(
    AssetImage('assets/onboarding/hero.jpg'),
    width: 900,
  );
}

class OnboardingPage extends StatefulWidget {
  const OnboardingPage({
    super.key,
    required this.index,
    required this.virtualIndex,
    required this.controller,
    required this.entrance,
    this.authProgress = const AlwaysStoppedAnimation(0),
  });
  final int index;
  final int virtualIndex;
  final PageController controller;
  final Animation<double> entrance;
  final Animation<double> authProgress;

  @override
  State<OnboardingPage> createState() => _OnboardingPageState();
}

class _OnboardingPageState extends State<OnboardingPage>
    with SingleTickerProviderStateMixin {
  late final AnimationController _arrival;
  bool _entered = false;
  int get index => widget.index;
  int get virtualIndex => widget.virtualIndex;
  PageController get controller => widget.controller;
  Animation<double> get entrance => widget.entrance;

  @override
  void initState() {
    super.initState();
    _arrival = AnimationController(
      vsync: this,
      duration: OnboardingMotion.contentSequence,
    );
    controller.addListener(_trackArrival);
  }

  void _trackArrival() {
    if (index == 0 || !controller.hasClients) return;
    final distance =
        ((controller.page ?? controller.initialPage.toDouble()) - virtualIndex)
            .abs();
    if (distance > .99) _entered = false;
    if (!_entered && distance <= .5) {
      _entered = true;
      if (MediaQuery.disableAnimationsOf(context)) {
        _arrival.value = 1;
      } else {
        _arrival.forward(from: 0);
      }
    }
  }

  @override
  void dispose() {
    controller.removeListener(_trackArrival);
    _arrival.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduced = MediaQuery.disableAnimationsOf(context);
    return LayoutBuilder(
      builder: (context, constraints) {
        final s = constraints.maxWidth / 360;
        final compact = constraints.maxHeight < 500 * s;
        final largeType = MediaQuery.textScalerOf(context).scale(16) > 18;
        Widget reveal(
          Widget child,
          int beat, {
          bool image = false,
          int delay = 0,
          bool fromRight = false,
        }) {
          child = OnboardingAuthPart(
            progress: widget.authProgress,
            visual: image || (index == 2 && beat == 1),
            child: child,
          );
          if (index != 0) {
            return OnboardingSlideIn(
              animation: _arrival,
              delay: delay,
              offset: Offset(fromRight ? 24 : -24, 0),
              child: child,
            );
          }
          return OnboardingReveal(
            animation: entrance,
            start: [80 / 700, 150 / 700, 250 / 700][beat],
            end: [300 / 700, 550 / 700, 600 / 700][beat],
            image: image,
            child: AnimatedBuilder(
              animation: controller,
              child: child,
              builder: (context, child) {
                final delta = reduced || !controller.hasClients
                    ? 0.0
                    : ((controller.page ?? controller.initialPage.toDouble()) -
                              virtualIndex)
                          .clamp(-1.0, 1.0);
                return Transform.translate(
                  offset: Offset(delta * (image ? 18 : -8), 0),
                  child: child,
                );
              },
            ),
          );
        }

        final composition = switch (index) {
          0 => _WelcomeComposition(
            scale: s,
            reveal: reveal,
            largeType: largeType,
            compact: compact,
          ),
          1 => _HospitalityComposition(
            scale: s,
            reveal: reveal,
            largeType: largeType,
            compact: compact,
          ),
          _ => _OpportunitiesComposition(
            scale: s,
            reveal: reveal,
            largeType: largeType,
            compact: compact,
          ),
        };
        return SingleChildScrollView(
          key: PageStorageKey('onboarding-scroll-$index'),
          padding: const EdgeInsets.only(bottom: 16),
          child: AnimatedBuilder(
            animation: controller,
            child: composition,
            builder: (context, child) {
              final distance = reduced || !controller.hasClients
                  ? 0.0
                  : ((controller.page ?? controller.initialPage.toDouble()) -
                            virtualIndex)
                        .abs()
                        .clamp(0.0, 1.0);
              return Opacity(
                opacity: 1 - distance * .18,
                child: Transform.scale(scale: 1 - distance * .03, child: child),
              );
            },
          ),
        );
      },
    );
  }
}

typedef _Reveal =
    Widget Function(
      Widget child,
      int beat, {
      bool image,
      int delay,
      bool fromRight,
    });

Text _text(
  String value,
  double size, {
  Color color = onboardingInk,
  String? family,
  double height = 1.08,
  double spacing = -.7,
}) => Text(
  value,
  style: TextStyle(
    fontSize: size,
    fontWeight: FontWeight.w400,
    height: height,
    letterSpacing: spacing,
    color: color,
    fontFamily: family,
  ),
);

Widget _photo(ImageProvider image, {Alignment alignment = Alignment.center}) =>
    Image(
      image: image,
      fit: BoxFit.cover,
      alignment: alignment,
      width: double.infinity,
      height: double.infinity,
      excludeFromSemantics: true,
    );

class _WelcomeComposition extends StatelessWidget {
  const _WelcomeComposition({
    required this.scale,
    required this.reveal,
    required this.largeType,
    required this.compact,
  });
  final double scale;
  final _Reveal reveal;
  final bool largeType;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final photo = reveal(
      ClipPath(
        clipper: _EditorialClipper(),
        child: _photo(
          OnboardingPhotos.reception,
          alignment: const Alignment(-.35, 0),
        ),
      ),
      1,
      image: true,
    );
    return Column(
      children: [
        SizedBox(height: (largeType || compact ? 20 : 77) * scale),
        reveal(_text('WELCOME', 34 * scale, spacing: -1), 0),
        SizedBox(height: (compact ? 24 : 34) * scale),
        SizedBox(
          height: (compact ? 190 : 237) * scale,
          width: double.infinity,
          child: photo,
        ),
        SizedBox(height: (compact ? 20 : 26) * scale),
        Padding(
          padding: EdgeInsets.symmetric(horizontal: 40 * scale),
          child: reveal(_text('Your next move\nstarts here.', 35 * scale), 2),
        ),
      ],
    );
  }
}

class _EditorialClipper extends CustomClipper<Path> {
  @override
  Path getClip(Size size) => Path()
    ..moveTo(0, size.height * .14)
    ..lineTo(size.width * .15, size.height * .16)
    ..lineTo(size.width * .24, 0)
    ..lineTo(size.width * .96, 0)
    ..lineTo(size.width * .86, size.height * .31)
    ..lineTo(size.width * .93, size.height * .48)
    ..lineTo(size.width * .93, size.height * .77)
    ..lineTo(size.width, size.height * .76)
    ..lineTo(size.width * .93, size.height)
    ..lineTo(size.width * .93, size.height * .81)
    ..lineTo(size.width * .35, size.height * .95)
    ..lineTo(size.width * .35, size.height * .83)
    ..lineTo(size.width * .06, size.height * .83)
    ..close();
  @override
  bool shouldReclip(_EditorialClipper oldClipper) => false;
}

class _HospitalityComposition extends StatelessWidget {
  const _HospitalityComposition({
    required this.scale,
    required this.reveal,
    required this.largeType,
    required this.compact,
  });
  final double scale;
  final _Reveal reveal;
  final bool largeType;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final heading = reveal(
      _text(
        'Step into\nhospitality\nat its finest.',
        34 * scale,
        family: 'serif',
        color: const Color(0xFF34212C),
        height: 1.03,
      ),
      0,
      delay: 100,
    );
    final description = reveal(
      _text(
        'Discover premium event, dining, and guest experience roles where every detail matters.',
        14 * scale,
        color: onboardingMuted,
        height: 1.5,
        spacing: 0,
      ),
      2,
      delay: 250,
      fromRight: true,
    );
    Widget photo(
      ImageProvider image,
      BorderRadius radius, {
      int delay = 50,
      bool fromRight = false,
    }) => reveal(
      ClipRRect(borderRadius: radius, child: _photo(image)),
      1,
      image: true,
      delay: delay,
      fromRight: fromRight,
    );
    final housekeeping = photo(
      OnboardingPhotos.housekeeping,
      const BorderRadius.only(
        topRight: Radius.circular(24),
        bottomRight: Radius.circular(24),
      ),
    );
    final reception = photo(
      OnboardingPhotos.reception,
      const BorderRadius.only(
        topLeft: Radius.circular(24),
        bottomLeft: Radius.circular(24),
      ),
      delay: 150,
      fromRight: true,
    );
    final dining = reveal(
      Stack(
        fit: StackFit.expand,
        children: [
          ClipRRect(
            borderRadius: const BorderRadius.only(
              topRight: Radius.circular(24),
              bottomRight: Radius.circular(24),
            ),
            child: _photo(OnboardingPhotos.dining),
          ),
          Positioned(
            top: 14,
            left: 12,
            right: 12,
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
              decoration: BoxDecoration(
                color: const Color(0xB334212C),
                borderRadius: BorderRadius.circular(24),
              ),
              child: const Text(
                'HOSPITALITY CAREERS',
                textAlign: TextAlign.center,
                style: TextStyle(
                  color: Colors.white,
                  fontSize: 8,
                  letterSpacing: .7,
                ),
              ),
            ),
          ),
        ],
      ),
      1,
      image: true,
      delay: 200,
    );
    if (largeType) {
      return Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SizedBox(height: 130 * scale, child: housekeeping),
            const SizedBox(height: 20),
            heading,
            const SizedBox(height: 24),
            SizedBox(height: 190 * scale, child: reception),
            const SizedBox(height: 24),
            description,
            const SizedBox(height: 24),
            SizedBox(height: 230 * scale, child: dining),
          ],
        ),
      );
    }
    Widget at(double x, double y, double w, double h, Widget child) =>
        Positioned(
          left: x * scale,
          top: y * scale,
          width: w * scale,
          height: h * scale,
          child: child,
        );
    return SizedBox(
      height: (compact ? 390 : 535) * scale,
      child: Stack(
        children: [
          at(0, 0, 132, compact ? 80 : 102, housekeeping),
          at(16, compact ? 90 : 112, 187, 169, heading),
          at(198, compact ? 80 : 90, 162, 158, reception),
          at(0, compact ? 250 : 280, 163, compact ? 140 : 255, dining),
          at(189, compact ? 252 : 339, 157, compact ? 138 : 175, description),
        ],
      ),
    );
  }
}

class _OpportunitiesComposition extends StatelessWidget {
  const _OpportunitiesComposition({
    required this.scale,
    required this.reveal,
    required this.largeType,
    required this.compact,
  });
  final double scale;
  final _Reveal reveal;
  final bool largeType;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final s = scale;
    Widget card(Color color, Widget child) => Container(
      padding: EdgeInsets.all(15 * s),
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(21 * s),
      ),
      child: child,
    );
    final job = card(
      onboardingInk,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
                decoration: BoxDecoration(
                  color: Colors.white.withValues(alpha: .09),
                  borderRadius: BorderRadius.circular(20),
                ),
                child: Text(
                  'BEST MATCH',
                  style: TextStyle(
                    color: Colors.white70,
                    fontSize: 8 * s,
                    letterSpacing: .7,
                  ),
                ),
              ),
              const Spacer(),
              const Icon(Icons.north_east, size: 17, color: Colors.white),
            ],
          ),
          if (!largeType) const Spacer() else const SizedBox(height: 28),
          _text('Event\nSupervisor', 21 * s, color: Colors.white, spacing: -.3),
          const SizedBox(height: 8),
          _text(
            'London \u00b7 \u00a314\u201318/hr',
            11 * s,
            color: const Color(0xFFB6B6AF),
            spacing: 0,
          ),
        ],
      ),
    );
    final match = card(
      const Color(0xFFDED3FF),
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const CircleAvatar(
            radius: 18,
            backgroundColor: Color(0xFF724AFF),
            child: Icon(Icons.track_changes, size: 20, color: Colors.white),
          ),
          if (!largeType) const Spacer() else const SizedBox(height: 28),
          _text('94%', 32 * s),
          const SizedBox(height: 5),
          _text('profile match', 11 * s, spacing: 0),
        ],
      ),
    );
    final strengths = card(
      Colors.white,
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(child: _text('Your strengths', 12 * s, spacing: 0)),
              const Icon(
                Icons.auto_awesome_outlined,
                size: 16,
                color: Color(0xFF724AFF),
              ),
            ],
          ),
          const SizedBox(height: 12),
          Wrap(
            spacing: 4,
            runSpacing: 5,
            children: ['Hospitality', 'Service', 'Events']
                .map(
                  (label) => Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 8,
                      vertical: 5,
                    ),
                    decoration: BoxDecoration(
                      color: const Color(0xFFF0EFEB),
                      borderRadius: BorderRadius.circular(20),
                    ),
                    child: _text(label, 9 * s, spacing: 0),
                  ),
                )
                .toList(),
          ),
        ],
      ),
    );
    final opportunities = card(
      const Color(0xFFCEF1DA),
      Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _text(
            '\u25cf  36 new',
            11 * s,
            color: const Color(0xFF216C42),
            spacing: 0,
          ),
          if (!largeType) const Spacer() else const SizedBox(height: 28),
          _text(
            'Relevant\nopportunities\nthis week',
            17 * s,
            spacing: -.2,
            height: 1.1,
          ),
        ],
      ),
    );
    final jobEntrance = reveal(job, 1, delay: 60);
    final matchEntrance = reveal(match, 1, delay: 120, fromRight: true);
    final strengthsEntrance = reveal(strengths, 1, delay: 180);
    final opportunitiesEntrance = reveal(
      opportunities,
      1,
      delay: 240,
      fromRight: true,
    );
    Widget row(Widget a, Widget b, int flexA, int flexB, double height) =>
        SizedBox(
          height: height * s,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(flex: flexA, child: a),
              SizedBox(width: 10 * s),
              Expanded(flex: flexB, child: b),
            ],
          ),
        );
    return Padding(
      padding: EdgeInsets.symmetric(horizontal: 16 * s),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(height: (compact ? 14 : 34) * s),
          reveal(_text('Everything you need\nto move forward.', 34 * s), 0),
          SizedBox(height: (compact ? 18 : 24) * s),
          (largeType
              ? Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    jobEntrance,
                    const SizedBox(height: 10),
                    matchEntrance,
                    const SizedBox(height: 10),
                    strengthsEntrance,
                    const SizedBox(height: 10),
                    opportunitiesEntrance,
                  ],
                )
              : Column(
                  children: [
                    row(
                      jobEntrance,
                      matchEntrance,
                      57,
                      43,
                      compact ? 148 : 168,
                    ),
                    SizedBox(height: 10 * s),
                    row(
                      strengthsEntrance,
                      opportunitiesEntrance,
                      49,
                      51,
                      compact ? 115 : 123,
                    ),
                  ],
                )),
          SizedBox(height: 13 * s),
          reveal(
            _text(
              'Illustrative preview \u00b7 not live opportunities',
              10 * s,
              color: onboardingMuted,
              spacing: 0,
              height: 1.4,
            ),
            2,
            delay: 240,
          ),
        ],
      ),
    );
  }
}
