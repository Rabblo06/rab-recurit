import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/api/api_client.dart';
import '../../core/theme/schedule_tokens.dart';
import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_toast.dart';
import 'send_shift_screen.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart' show initials;

const staffNavy = Color(0xFF0F172A);
const staffAvatarBackground = Color(0xFFEDEBE6);
const staffMuted = Color(0xFF6B7280);
const _sectionGrey = Color(0xFF9CA3AF);
const _chipGrey = Color(0xFFF1F0EC);
const _dayOff = Color(0xFFF1F1F3);

const notAssignedMessage = 'This staff member is no longer assigned to you';

/// "full_time" → "Full time". Formatting only — the value itself is the
/// server's; nothing is invented when it is absent.
String humanizeToken(String value) {
  final words = value.replaceAll(RegExp(r'[_-]+'), ' ').trim();
  if (words.isEmpty) return value;
  return words[0].toUpperCase() + words.substring(1).toLowerCase();
}

String yearsLabel(int years) => years == 1 ? '1 year' : '$years years';

/// Error copy for a failed staff call. 404 means the assignment ended.
String staffErrorMessage(Object error, {String action = 'update'}) {
  if (error is ApiException && error.statusCode == 404) {
    return notAssignedMessage;
  }
  if (error is ApiException && error.statusCode == 403) {
    return action == 'view'
        ? 'You do not have permission to view this staff member.'
        : 'You do not have permission to change staff tags.';
  }
  if (error is! ApiException) {
    final network = userMessageFor(error, fallback: '');
    if (network.isNotEmpty) return network;
  }
  return action == 'view'
      ? 'Unable to load this staff profile. Please try again.'
      : 'Unable to update this staff member. Please try again.';
}

bool isNotAssigned(Object error) =>
    error is ApiException && error.statusCode == 404;

void showStaffErrorToast(BuildContext context, String message) =>
    ScheduleToast.show(context, message, kind: ScheduleMessageKind.error);

/// Neutral initials tile — never a fabricated photo.
class StaffInitialsSquare extends StatelessWidget {
  const StaffInitialsSquare({
    super.key,
    required this.name,
    required this.size,
    this.radius,
  });
  final String name;
  final double size;
  final double? radius;
  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: Container(
      width: size,
      height: size,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: staffAvatarBackground,
        borderRadius: BorderRadius.circular(radius ?? size * .27),
      ),
      child: Text(
        initials(name),
        textScaler: TextScaler.noScaling,
        style: TextStyle(
          fontSize: size * .3,
          fontWeight: FontWeight.w800,
          color: staffNavy,
        ),
      ),
    ),
  );
}

class _SectionHeader extends StatelessWidget {
  const _SectionHeader(this.text);
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(top: 22, bottom: 10),
    child: Semantics(
      header: true,
      child: Text(
        text,
        style: const TextStyle(
          fontSize: 11.5,
          fontWeight: FontWeight.w700,
          letterSpacing: 1.4,
          color: _sectionGrey,
        ),
      ),
    ),
  );
}

class _KeyValue extends StatelessWidget {
  const _KeyValue(this.label, this.value);
  final String label, value;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 7),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Expanded(
          child: Text(
            label,
            style: const TextStyle(fontSize: 14.5, color: staffMuted),
          ),
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Text(
            value,
            textAlign: TextAlign.right,
            style: const TextStyle(
              fontSize: 14.5,
              fontWeight: FontWeight.w600,
              color: staffNavy,
            ),
          ),
        ),
      ],
    ),
  );
}

const _notProvided = Padding(
  padding: EdgeInsets.symmetric(vertical: 4),
  child: Text(
    'Not provided',
    style: TextStyle(fontSize: 14, color: _sectionGrey),
  ),
);

/// WORK PROFILE key rows — only the values the server returned.
class StaffWorkProfile extends StatelessWidget {
  const StaffWorkProfile({super.key, required this.profile});
  final VenueStaffProfile profile;
  @override
  Widget build(BuildContext context) {
    final rows = [
      if (profile.jobRoleName != null)
        _KeyValue('Primary role', profile.jobRoleName!),
      if (profile.employmentType != null)
        _KeyValue('Employment type', humanizeToken(profile.employmentType!)),
      if (profile.yearsExperience != null)
        _KeyValue('Experience', yearsLabel(profile.yearsExperience!)),
    ];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        const _SectionHeader('WORK PROFILE'),
        if (rows.isEmpty) _notProvided else ...rows,
      ],
    );
  }
}

const _week = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

class _Days extends StatelessWidget {
  const _Days(this.days);
  final Set<String> days;
  @override
  Widget build(BuildContext context) {
    final lower = days.map((d) => d.toLowerCase()).toSet();
    return Row(
      children: [
        for (final day in _week)
          Expanded(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              child: Semantics(
                label:
                    '$day: ${lower.contains(day.toLowerCase()) ? 'available' : 'not listed'}',
                child: ExcludeSemantics(
                  child: AspectRatio(
                    aspectRatio: 1,
                    child: Container(
                      key: ValueKey(
                        'vm-staff-day-$day-${lower.contains(day.toLowerCase()) ? 'on' : 'off'}',
                      ),
                      alignment: Alignment.center,
                      decoration: BoxDecoration(
                        color: lower.contains(day.toLowerCase())
                            ? staffNavy
                            : _dayOff,
                        borderRadius: BorderRadius.circular(10),
                      ),
                      child: Text(
                        day[0],
                        textScaler: TextScaler.noScaling,
                        style: TextStyle(
                          fontSize: 14,
                          fontWeight: FontWeight.w700,
                          color: lower.contains(day.toLowerCase())
                              ? Colors.white
                              : _sectionGrey,
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
  }
}

/// Venue Manager view of one assigned staff member.
class VenueStaffProfileScreen extends StatefulWidget {
  const VenueStaffProfileScreen({
    super.key,
    required this.user,
    this.selectionContext = false,
    this.onChanged,
    this.onGone,
  });
  final DirectoryUser user;

  /// Opened while selecting staff: the primary action returns `true`
  /// ("select this staff member") instead of opening Send Shift.
  final bool selectionContext;

  /// Receives the row with the server-confirmed tag state after a change.
  final ValueChanged<DirectoryUser>? onChanged;

  /// Called once when the server says this staff member is no longer
  /// assigned (404), so the list behind can refresh.
  final VoidCallback? onGone;
  @override
  State<VenueStaffProfileScreen> createState() =>
      _VenueStaffProfileScreenState();
}

class _VenueStaffProfileScreenState extends State<VenueStaffProfileScreen> {
  VenueStaffProfile? profile;
  Object? error;
  bool busy = false;
  late DirectoryUser user = widget.user;
  bool _goneReported = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    setState(() {
      error = null;
      profile = null;
    });
    try {
      final loaded = await context
          .read<VenueManagerProvider>()
          .fetchStaffProfile(widget.user.id);
      if (mounted) setState(() => profile = loaded);
    } catch (e) {
      if (!mounted) return;
      setState(() => error = e);
      if (isNotAssigned(e)) _reportGone();
    }
  }

  void _reportGone() {
    if (_goneReported) return;
    _goneReported = true;
    widget.onGone?.call();
  }

  Future<void> _toggleFavourite() async {
    final current = profile;
    if (current == null || busy) return;
    setState(() => busy = true);
    try {
      final tags = await context.read<VenueManagerProvider>().setStaffTags(
        current.id,
        favourite: !current.isFavourite,
      );
      if (!mounted) return;
      setState(() {
        current.isFavourite = tags.isFavourite;
        current.isEmergency = tags.isEmergency;
        user = user.withTags(
          isFavourite: tags.isFavourite,
          isEmergency: tags.isEmergency,
        );
      });
      widget.onChanged?.call(user);
    } catch (e) {
      if (!mounted) return;
      if (isNotAssigned(e)) {
        // The inline "no longer assigned" state replaces the profile; a toast
        // would announce the same message twice.
        setState(() => error = e);
        _reportGone();
      } else {
        showStaffErrorToast(context, staffErrorMessage(e));
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  void _primary() {
    if (widget.selectionContext) {
      Navigator.pop(context, true);
      return;
    }
    Navigator.of(context).push(
      MaterialPageRoute<String>(
        builder: (_) => SendShiftScreen(initialStaff: {user.id: user}),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final current = profile;
    final canSend = p.allows('staffing_request.create');
    final favourite = current?.isFavourite ?? user.isFavourite;
    final emergency = current?.isEmergency ?? user.isEmergency;
    final gone = error != null && isNotAssigned(error!);
    return Scaffold(
      key: const ValueKey('vm-staff-profile'),
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(8, 6, 12, 0),
              child: Row(
                children: [
                  IconButton(
                    tooltip: 'Back',
                    onPressed: () => Navigator.maybePop(context),
                    icon: const Icon(Icons.arrow_back, color: staffNavy),
                  ),
                  const SizedBox(width: 4),
                  const Expanded(
                    child: Text(
                      'Staff Profile',
                      style: TextStyle(
                        fontSize: 18,
                        fontWeight: FontWeight.w600,
                        color: staffNavy,
                      ),
                    ),
                  ),
                  IconButton(
                    key: const ValueKey('vm-staff-profile-favourite'),
                    tooltip: favourite
                        ? 'Remove from favourite'
                        : 'Add to favourite',
                    onPressed: current == null || busy
                        ? null
                        : _toggleFavourite,
                    icon: Icon(
                      favourite ? Icons.favorite : Icons.favorite_border,
                      color: favourite ? const Color(0xFFE11D48) : staffNavy,
                    ),
                  ),
                ],
              ),
            ),
            Expanded(
              child: LayoutBuilder(
                builder: (context, box) {
                  final square = math.min(180.0, box.maxWidth * .4);
                  final scale = MediaQuery.textScalerOf(context).scale(1);
                  final hero = math.max(
                    square + 40,
                    40 + (2 * 38 + 24 + 2 * 22) * scale,
                  );
                  final initial = ((box.maxHeight - hero) / box.maxHeight)
                      .clamp(.3, .85);
                  return Stack(
                    children: [
                      Padding(
                        padding: const EdgeInsets.fromLTRB(24, 12, 20, 0),
                        child: Row(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Expanded(
                              child: Column(
                                crossAxisAlignment: CrossAxisAlignment.start,
                                children: [
                                  Text(
                                    user.name.toUpperCase(),
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 34,
                                      height: 1.05,
                                      fontWeight: FontWeight.w900,
                                      color: staffNavy,
                                    ),
                                  ),
                                  if ((current?.jobRoleName ??
                                          user.jobRoleName) !=
                                      null) ...[
                                    const SizedBox(height: 8),
                                    Text(
                                      (current?.jobRoleName ??
                                          user.jobRoleName)!,
                                      style: const TextStyle(
                                        fontSize: 16,
                                        color: staffMuted,
                                      ),
                                    ),
                                  ],
                                  const SizedBox(height: 12),
                                  if (favourite)
                                    const _Tag(
                                      icon: Icons.favorite,
                                      color: Color(0xFFE11D48),
                                      text: 'Favourited',
                                    ),
                                  if (emergency)
                                    const _Tag(
                                      icon: Icons.warning_amber_rounded,
                                      color: Color(0xFFB45309),
                                      text: 'Emergency cover',
                                    ),
                                ],
                              ),
                            ),
                            const SizedBox(width: 12),
                            StaffInitialsSquare(
                              name: user.name,
                              size: square,
                              radius: square * .27,
                            ),
                          ],
                        ),
                      ),
                      DraggableScrollableSheet(
                        initialChildSize: initial,
                        minChildSize: initial,
                        maxChildSize: .95,
                        builder: (context, controller) => DecoratedBox(
                          decoration: const BoxDecoration(
                            color: Colors.white,
                            borderRadius: BorderRadius.vertical(
                              top: Radius.circular(ScheduleTokens.sheetRadius),
                            ),
                            boxShadow: ScheduleTokens.shadows,
                          ),
                          child: SingleChildScrollView(
                            controller: controller,
                            padding: const EdgeInsets.fromLTRB(24, 10, 24, 24),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                Center(
                                  child: Container(
                                    width: 40,
                                    height: 4,
                                    decoration: BoxDecoration(
                                      color: const Color(0xFFD9D9DE),
                                      borderRadius: BorderRadius.circular(2),
                                    ),
                                  ),
                                ),
                                if (error != null)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 24),
                                    child: ScheduleMessageCard(
                                      title: staffErrorMessage(
                                        error!,
                                        action: 'view',
                                      ),
                                      kind: ScheduleMessageKind.error,
                                      actionLabel:
                                          gone ||
                                              (error is ApiException &&
                                                  (error as ApiException)
                                                          .statusCode ==
                                                      403)
                                          ? null
                                          : 'Retry',
                                      onAction: _load,
                                    ),
                                  )
                                else if (current == null)
                                  const Padding(
                                    padding: EdgeInsets.all(32),
                                    child: Center(
                                      child: CircularProgressIndicator(),
                                    ),
                                  )
                                else
                                  ..._sections(current),
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
          ],
        ),
      ),
      bottomNavigationBar: ColoredBox(
        color: Colors.white,
        child: SafeArea(
          top: false,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(24, 8, 24, 12),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (!widget.selectionContext && !canSend && !p.loading)
                  const Padding(
                    padding: EdgeInsets.only(bottom: 8),
                    child: Text(
                      'Your account cannot send shift offers.',
                      style: ScheduleTokens.label,
                    ),
                  ),
                SizedBox(
                  width: double.infinity,
                  height: 56,
                  child: FilledButton(
                    key: const ValueKey('vm-staff-profile-primary'),
                    style: FilledButton.styleFrom(
                      backgroundColor: staffNavy,
                      foregroundColor: Colors.white,
                      shape: RoundedRectangleBorder(
                        borderRadius: BorderRadius.circular(16),
                      ),
                      textStyle: const TextStyle(
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    onPressed: gone || (!widget.selectionContext && !canSend)
                        ? null
                        : _primary,
                    child: Text(
                      widget.selectionContext ? 'Select Staff' : 'Send Offer',
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  List<Widget> _sections(VenueStaffProfile profile) {
    final hasAvailability =
        profile.availableDays.isNotEmpty ||
        profile.preferredShiftTimes != null ||
        profile.maxHoursPerWeek != null;
    return [
      StaffWorkProfile(profile: profile),
      if (profile.skills.isNotEmpty) ...[
        const _SectionHeader('SKILLS'),
        Wrap(
          spacing: 8,
          runSpacing: 8,
          children: [
            for (final skill in profile.skills)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: 14,
                  vertical: 8,
                ),
                decoration: BoxDecoration(
                  color: _chipGrey,
                  borderRadius: BorderRadius.circular(999),
                ),
                child: Text(
                  skill,
                  style: const TextStyle(fontSize: 13.5, color: staffNavy),
                ),
              ),
          ],
        ),
      ],
      const _SectionHeader('AVAILABILITY'),
      if (!hasAvailability) _notProvided,
      if (profile.availableDays.isNotEmpty) _Days(profile.availableDays),
      if (hasAvailability && profile.availableDays.isEmpty)
        const _KeyValue('Days', 'Not provided'),
      if (profile.preferredShiftTimes != null) ...[
        const SizedBox(height: 8),
        _KeyValue('Preferred shift', profile.preferredShiftTimes!),
      ],
      if (profile.maxHoursPerWeek != null)
        _KeyValue('Maximum hours', '${profile.maxHoursPerWeek} hrs/week'),
    ];
  }
}

class _Tag extends StatelessWidget {
  const _Tag({required this.icon, required this.color, required this.text});
  final IconData icon;
  final Color color;
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 6),
    child: Row(
      children: [
        Icon(icon, size: 16, color: color),
        const SizedBox(width: 6),
        Flexible(
          child: Text(
            text,
            style: const TextStyle(
              fontSize: 13.5,
              fontWeight: FontWeight.w600,
              color: staffNavy,
            ),
          ),
        ),
      ],
    ),
  );
}
