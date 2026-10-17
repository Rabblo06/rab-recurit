import '../../core/api/api_client.dart';
import '../../core/widgets/schedule_feedback.dart';
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/semantics.dart';
import 'package:provider/provider.dart';
import '../../core/theme/schedule_tokens.dart';
import 'send_shift_screen.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';
import 'venue_staff_profile.dart';

const employmentFilters = <String?, String>{
  null: 'All',
  'active': 'Active',
  'pending_compliance': 'Pending compliance',
  'inactive': 'Inactive',
  'suspended': 'Suspended',
};

const _rowBorder = Color(0xFFECEAE5);
const _checkboxOff = Color(0xFFC7CBD1);

/// Real, backend-derived Available/Not Available — never an internal
/// account-state label. Rendered only when the server evaluated a window
/// (`available` present); absent means "not evaluated", so no badge.
class _AvailabilityBadge extends StatelessWidget {
  const _AvailabilityBadge({required this.available});
  final bool available;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
    decoration: BoxDecoration(
      color: available ? const Color(0xFFE7F6EC) : const Color(0xFFFDECEC),
      borderRadius: BorderRadius.circular(999),
    ),
    child: Text(
      available ? 'Available' : 'Not Available',
      style: TextStyle(
        fontSize: 11,
        fontWeight: FontWeight.w600,
        color: available ? const Color(0xFF1F8A4C) : const Color(0xFFC0392B),
      ),
    ),
  );
}

/// Send Shift's staff picker: the same single Users page, always selecting.
/// "Done" (or "Send Offer") pops with the selection; Back discards edits.
class VenueSelectStaffScreen extends StatelessWidget {
  const VenueSelectStaffScreen({
    super.key,
    required this.initialSelection,
    this.startAt,
    this.endAt,
    this.excludeShiftId,
  });
  final Map<String, DirectoryUser> initialSelection;
  final DateTime? startAt, endAt;
  final String? excludeShiftId;
  @override
  Widget build(BuildContext context) => VenueUsersScreen(
    picker: true,
    initialSelection: initialSelection,
    startAt: startAt,
    endAt: endAt,
    excludeShiftId: excludeShiftId,
  );
}

enum _QuickAction { favourite, emergency, sendOffer, select, viewProfile }

/// The ONE Users page in the Venue Manager app: only Staff the Initial
/// Manager assigned to this VM (`GET /staff/venue-directory`). There is no
/// discovery pool, and the VM can never add or remove team members.
class VenueUsersScreen extends StatefulWidget {
  const VenueUsersScreen({
    super.key,
    this.picker = false,
    this.initialSelection = const {},
    this.startAt,
    this.endAt,
    this.excludeShiftId,
  });

  /// Opened from Send Shift: always selecting; the selection is returned.
  final bool picker;
  final Map<String, DirectoryUser> initialSelection;

  /// The real shift window (picker only). From My Space there is no shift
  /// in mind, so the server is asked for a real "busy right now" signal
  /// (a minimal now→now+1min window) instead.
  final DateTime? startAt, endAt;
  final String? excludeShiftId;
  @override
  State<VenueUsersScreen> createState() => _VenueUsersScreenState();
}

class _VenueUsersScreenState extends State<VenueUsersScreen> {
  final search = TextEditingController();
  Timer? debounce;
  late final selected = Map<String, DirectoryUser>.of(widget.initialSelection);
  late bool selecting = widget.picker;
  List<DirectoryUser> users = [];
  int page = 1, total = 0, generation = 0;
  bool loading = true, quickOpen = false;
  Object? loadError;
  String? status, tag;
  DateTime? scope;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final p = context.watch<VenueManagerProvider>();
    if (!p.loading && p.updatedAt != scope) {
      scope = p.updatedAt;
      users = [];
      loading = true;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) load();
      });
    }
  }

  @override
  void dispose() {
    generation++;
    debounce?.cancel();
    search.dispose();
    super.dispose();
  }

  Future<void> load({bool more = false}) async {
    final stamp = ++generation;
    setState(() {
      loading = true;
      loadError = null;
      if (!more) {
        page = 1;
        users = [];
      }
    });
    final now = DateTime.now();
    try {
      final result = await context.read<VenueManagerProvider>().searchUsers(
        search.text,
        more ? page + 1 : 1,
        status: status,
        tag: tag,
        startAt: widget.picker ? widget.startAt : now,
        endAt: widget.picker
            ? widget.endAt
            : now.add(const Duration(minutes: 1)),
        excludeShiftId: widget.excludeShiftId,
      );
      if (!mounted || stamp != generation) return;
      setState(() {
        users = [if (more) ...users, ...result.users];
        total = result.total;
        if (more) page++;
        loading = false;
      });
    } catch (e) {
      if (mounted && stamp == generation) {
        setState(() {
          loading = false;
          loadError = e;
        });
      }
    }
  }

  void _setTag(String? next) {
    if (tag == next) return;
    tag = next;
    load();
  }

  void _setStatus(String? next) {
    status = next;
    load();
  }

  Future<void> filters() async {
    await showScheduleSheet<void>(
      context: context,
      builder: (sheet) => Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ListTile(title: Text('Employment status')),
          for (final entry in employmentFilters.entries)
            ListTile(
              title: Text(entry.value),
              trailing: status == entry.key ? const Icon(Icons.check) : null,
              onTap: () {
                Navigator.pop(sheet);
                _setStatus(entry.key);
              },
            ),
        ],
      ),
    );
  }

  /// Applies server-confirmed tag state to the visible row and selection.
  void _replace(DirectoryUser next) {
    setState(() {
      final matchesTag =
          tag == null ||
          (tag == 'favourite' && next.isFavourite) ||
          (tag == 'emergency' && next.isEmergency);
      final index = users.indexWhere((u) => u.id == next.id);
      if (index >= 0) {
        if (matchesTag) {
          users[index] = next;
        } else {
          users.removeAt(index);
          total = (total - 1).clamp(0, total);
        }
      }
      if (selected.containsKey(next.id)) selected[next.id] = next;
    });
  }

  /// 404 for someone previously listed: the assignment ended. Drop them from
  /// the selection and reload the authoritative list.
  void _gone(String id, {bool announce = true}) {
    if (!mounted) return;
    setState(() => selected.remove(id));
    if (announce) showStaffErrorSnack(context, notAssignedMessage);
    load();
  }

  void _toggle(DirectoryUser user) {
    // A client-side UX guard only — never the authorization boundary.
    // Availability is advisory: final submission revalidates server-side.
    setState(() {
      if (selected.containsKey(user.id)) {
        selected.remove(user.id);
      } else if (selected.length < 100) {
        selected[user.id] = user;
      }
    });
  }

  Future<void> _setTags(
    DirectoryUser user, {
    bool? favourite,
    bool? emergency,
  }) async {
    try {
      final tags = await context.read<VenueManagerProvider>().setStaffTags(
        user.id,
        favourite: favourite,
        emergency: emergency,
      );
      if (!mounted) return;
      _replace(
        user.withTags(
          isFavourite: tags.isFavourite,
          isEmergency: tags.isEmergency,
        ),
      );
    } catch (e) {
      if (!mounted) return;
      if (isNotAssigned(e)) {
        _gone(user.id);
      } else {
        showStaffErrorSnack(context, staffErrorMessage(e));
      }
    }
  }

  bool get _canSend =>
      context.read<VenueManagerProvider>().allows('staffing_request.create');

  Future<void> _sendOffer(Map<String, DirectoryUser> staff) async {
    if (widget.picker) {
      Navigator.pop(context, Map<String, DirectoryUser>.of(selected));
      return;
    }
    if (staff.isEmpty || !_canSend) return;
    final created = await Navigator.of(context).push<String>(
      MaterialPageRoute(builder: (_) => SendShiftScreen(initialStaff: staff)),
    );
    if (mounted && created != null) {
      setState(() {
        selected.clear();
        selecting = false;
      });
    }
  }

  Future<void> _openProfile(DirectoryUser user) async {
    final select = await Navigator.of(context).push<bool>(
      MaterialPageRoute(
        builder: (_) => VenueStaffProfileScreen(
          user: user,
          selectionContext: selecting,
          onChanged: _replace,
          onGone: () => _gone(user.id, announce: false),
        ),
      ),
    );
    if (mounted && select == true && !selected.containsKey(user.id)) {
      final current = users.where((u) => u.id == user.id).firstOrNull;
      if (current != null) _toggle(current);
    }
  }

  void _run(_QuickAction action, DirectoryUser user) {
    switch (action) {
      case _QuickAction.favourite:
        _setTags(user, favourite: !user.isFavourite);
      case _QuickAction.emergency:
        _setTags(user, emergency: !user.isEmergency);
      case _QuickAction.sendOffer:
        _sendOffer({user.id: user});
      case _QuickAction.select:
        _toggle(user);
      case _QuickAction.viewProfile:
        _openProfile(user);
    }
  }

  Future<void> _quickActions(DirectoryUser user) async {
    if (quickOpen) return;
    quickOpen = true;
    var gone = false;
    final future = context
        .read<VenueManagerProvider>()
        .fetchStaffProfile(user.id)
        .catchError((Object e) {
          gone = isNotAssigned(e);
          throw e;
        });
    final action = await showGeneralDialog<_QuickAction>(
      context: context,
      barrierDismissible: true,
      barrierLabel: 'Dismiss quick actions',
      barrierColor: Colors.black.withValues(alpha: .45),
      transitionDuration: const Duration(milliseconds: 180),
      pageBuilder: (dialog, _, _) => _QuickActionsOverlay(
        user: user,
        profile: future,
        actions: _actionsFor(user),
      ),
    );
    quickOpen = false;
    if (!mounted) return;
    if (gone) {
      _gone(user.id);
      return;
    }
    if (action != null) {
      final current = users.where((u) => u.id == user.id).firstOrNull ?? user;
      _run(action, current);
    }
  }

  List<(_QuickAction, String, IconData)> _actionsFor(DirectoryUser u) => [
    (
      _QuickAction.favourite,
      u.isFavourite ? 'Remove from favourite' : 'Add to favourite',
      u.isFavourite ? Icons.favorite : Icons.favorite_border,
    ),
    (
      _QuickAction.emergency,
      u.isEmergency ? 'Remove from emergency' : 'Add to emergency',
      Icons.warning_amber_rounded,
    ),
    if (widget.picker)
      (
        _QuickAction.select,
        selected.containsKey(u.id) ? 'Remove from selection' : 'Select staff',
        Icons.check_box_outlined,
      )
    else if (_canSend)
      (_QuickAction.sendOffer, 'Send offer', Icons.send_rounded),
    (_QuickAction.viewProfile, 'View profile', Icons.person_outline),
  ];

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    final canSend = p.allows('staffing_request.create');
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
              child: Row(
                children: [
                  _RoundButton(
                    tooltip: 'Back',
                    icon: Icons.chevron_left,
                    onPressed: () => Navigator.maybePop(context),
                  ),
                  const Spacer(),
                  if (selecting)
                    _PillButton(
                      key: const ValueKey('vm-users-done'),
                      label: 'Done',
                      onPressed: widget.picker
                          ? () => Navigator.pop(
                              context,
                              Map<String, DirectoryUser>.of(selected),
                            )
                          : () => setState(() {
                              selecting = false;
                              selected.clear();
                            }),
                    )
                  else if (canSend && p.allows('staff.view'))
                    _PillButton(
                      key: const ValueKey('vm-users-select'),
                      label: 'Edit',
                      onPressed: () => setState(() => selecting = true),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Semantics(
                header: true,
                child: const Text(
                  'Users',
                  style: TextStyle(
                    fontSize: 28,
                    fontWeight: FontWeight.w700,
                    color: staffNavy,
                  ),
                ),
              ),
            ),
            if (selecting)
              Padding(
                padding: const EdgeInsets.fromLTRB(24, 2, 24, 0),
                child: Text(
                  '${selected.length} selected',
                  style: const TextStyle(fontSize: 13, color: staffMuted),
                ),
              ),
            const SizedBox(height: 14),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Row(
                children: [
                  Expanded(
                    child: Container(
                      height: 44,
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(24),
                        border: Border.all(color: _rowBorder),
                      ),
                      child: TextField(
                        key: const ValueKey('vm-users-search'),
                        controller: search,
                        style: ScheduleTokens.body.copyWith(fontSize: 15),
                        textInputAction: TextInputAction.search,
                        decoration: const InputDecoration(
                          hintText: 'Search staff…',
                          hintStyle: TextStyle(color: Color(0xFF9CA3AF)),
                          isDense: true,
                          prefixIcon: Icon(
                            Icons.search,
                            size: 20,
                            color: Color(0xFF9CA3AF),
                          ),
                          border: InputBorder.none,
                          contentPadding: EdgeInsets.symmetric(vertical: 12),
                        ),
                        onChanged: (_) {
                          debounce?.cancel();
                          generation++;
                          debounce = Timer(
                            const Duration(milliseconds: 300),
                            () => load(),
                          );
                        },
                      ),
                    ),
                  ),
                  const SizedBox(width: 10),
                  _RoundButton(
                    key: const ValueKey('vm-users-filter'),
                    tooltip: 'Filter users',
                    icon: Icons.tune,
                    onPressed: filters,
                    dot: status != null,
                    size: 44,
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(24, 12, 24, 4),
              child: Wrap(
                spacing: 8,
                runSpacing: 8,
                children: [
                  for (final (key, label) in const [
                    (null, 'All'),
                    ('favourite', 'Favourite'),
                    ('emergency', 'Emergency'),
                  ])
                    _TagChip(
                      key: ValueKey('vm-users-chip-${key ?? 'all'}'),
                      label: label,
                      selected: tag == key,
                      onTap: () => _setTag(key),
                    ),
                  if (status != null)
                    _TagChip(
                      key: const ValueKey('vm-users-chip-status'),
                      label: employmentFilters[status] ?? status!,
                      selected: false,
                      onTap: () => _setStatus(null),
                      removable: true,
                    ),
                ],
              ),
            ),
            const SizedBox(height: 8),
            Expanded(child: _body(p)),
            if (selecting)
              DecoratedBox(
                decoration: const BoxDecoration(
                  color: ScheduleTokens.homeBackground,
                ),
                child: SafeArea(
                  top: false,
                  child: Padding(
                    padding: const EdgeInsets.fromLTRB(24, 8, 24, 12),
                    child: SizedBox(
                      width: double.infinity,
                      height: 56,
                      child: FilledButton.icon(
                        key: const ValueKey('vm-users-send-offer'),
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
                        onPressed:
                            selected.isEmpty || (!widget.picker && !canSend)
                            ? null
                            : () => _sendOffer(
                                Map<String, DirectoryUser>.of(selected),
                              ),
                        icon: const Icon(Icons.send_rounded, size: 18),
                        label: const Text('Send Offer'),
                      ),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  Widget _body(VenueManagerProvider p) {
    if (p.error != null) return VmError(message: p.error!, retry: p.refresh);
    if (!p.loading && !p.allows('staff.view')) {
      return const Center(
        child: Padding(
          padding: EdgeInsets.all(ScheduleTokens.homeInset),
          child: ScheduleMessageCard(
            title: 'Staff viewing is not permitted.',
            kind: ScheduleMessageKind.error,
          ),
        ),
      );
    }
    final error = loadError;
    if (error != null) {
      if (error is ApiException && error.statusCode == 403) {
        return const Center(
          child: Padding(
            padding: EdgeInsets.all(ScheduleTokens.homeInset),
            child: ScheduleMessageCard(
              title: 'You do not have permission to view staff.',
              kind: ScheduleMessageKind.error,
            ),
          ),
        );
      }
      return VmError(
        message: 'Unable to load staff. Please try again.',
        retry: load,
      );
    }
    if (loading && users.isEmpty || p.loading) return const _UsersSkeleton();
    final filtered = search.text.trim().isNotEmpty || status != null;
    return RefreshIndicator(
      onRefresh: load,
      child: ListView(
        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
        physics: const AlwaysScrollableScrollPhysics(),
        children: [
          if (users.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: 32),
              child: Column(
                children: [
                  Text(
                    filtered
                        ? 'No staff match your search.'
                        : tag == 'favourite'
                        ? 'No favourite staff yet.'
                        : tag == 'emergency'
                        ? 'No emergency cover staff yet.'
                        : 'No staff assigned to you yet',
                    style: ScheduleTokens.body.copyWith(
                      fontWeight: FontWeight.w600,
                    ),
                    textAlign: TextAlign.center,
                  ),
                  if (!filtered && tag == null) ...[
                    const SizedBox(height: 6),
                    const Text(
                      'Your manager assigns staff to you',
                      style: ScheduleTokens.label,
                      textAlign: TextAlign.center,
                    ),
                  ],
                ],
              ),
            ),
          for (final u in users)
            Padding(
              padding: const EdgeInsets.only(bottom: 8),
              child: _StaffRow(
                key: ValueKey('vm-users-row-${u.id}'),
                user: u,
                selecting: selecting,
                selected: selected.containsKey(u.id),
                onTap: () => selecting ? _toggle(u) : _openProfile(u),
                onLongPress: () => _quickActions(u),
                semanticActions: {
                  for (final (action, label, _) in _actionsFor(u))
                    CustomSemanticsAction(label: label): () => _run(action, u),
                },
              ),
            ),
          if (users.length < total)
            TextButton(
              onPressed: loading ? null : () => load(more: true),
              child: Text(loading ? 'Loading…' : 'Load more'),
            ),
        ],
      ),
    );
  }
}

class _StaffRow extends StatelessWidget {
  const _StaffRow({
    super.key,
    required this.user,
    required this.selecting,
    required this.selected,
    required this.onTap,
    required this.onLongPress,
    required this.semanticActions,
  });
  final DirectoryUser user;
  final bool selecting, selected;
  final VoidCallback onTap, onLongPress;
  final Map<CustomSemanticsAction, VoidCallback> semanticActions;
  @override
  Widget build(BuildContext context) => Semantics(
    container: true,
    customSemanticsActions: semanticActions,
    selected: selecting ? selected : null,
    child: Material(
      color: Colors.white,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(13),
        side: const BorderSide(color: _rowBorder),
      ),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        onLongPress: onLongPress,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
          child: Row(
            children: [
              if (selecting) ...[
                _SquareCheck(checked: selected),
                const SizedBox(width: 12),
              ],
              CircleAvatar(
                radius: 18,
                backgroundColor: staffAvatarBackground,
                child: Text(
                  initials(user.name),
                  textScaler: TextScaler.noScaling,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    color: staffNavy,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(
                      children: [
                        Flexible(
                          child: Text(
                            user.name,
                            overflow: TextOverflow.ellipsis,
                            style: const TextStyle(
                              fontSize: 15,
                              fontWeight: FontWeight.w600,
                              color: staffNavy,
                            ),
                          ),
                        ),
                        if (user.isFavourite) ...[
                          const SizedBox(width: 6),
                          const Icon(
                            Icons.favorite,
                            size: 14,
                            color: Color(0xFFE11D48),
                            semanticLabel: 'Favourite',
                          ),
                        ],
                        if (user.isEmergency) ...[
                          const SizedBox(width: 4),
                          const Icon(
                            Icons.warning_amber_rounded,
                            size: 15,
                            color: Color(0xFFB45309),
                            semanticLabel: 'Emergency cover',
                          ),
                        ],
                      ],
                    ),
                    if (user.jobRoleName != null) ...[
                      const SizedBox(height: 2),
                      Text(
                        user.jobRoleName!,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 13, color: staffMuted),
                      ),
                    ],
                  ],
                ),
              ),
              if (user.available != null) ...[
                const SizedBox(width: 8),
                _AvailabilityBadge(available: user.available!),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

class _SquareCheck extends StatelessWidget {
  const _SquareCheck({required this.checked});
  final bool checked;
  @override
  Widget build(BuildContext context) => AnimatedContainer(
    duration: const Duration(milliseconds: 120),
    width: 22,
    height: 22,
    decoration: BoxDecoration(
      color: checked ? staffNavy : Colors.white,
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: checked ? staffNavy : _checkboxOff, width: 1.6),
    ),
    child: checked
        ? const Icon(Icons.check, size: 16, color: Colors.white)
        : null,
  );
}

class _RoundButton extends StatelessWidget {
  const _RoundButton({
    super.key,
    required this.tooltip,
    required this.icon,
    required this.onPressed,
    this.dot = false,
    this.size = 40,
  });
  final String tooltip;
  final IconData icon;
  final VoidCallback onPressed;
  final bool dot;
  final double size;
  @override
  Widget build(BuildContext context) => SizedBox(
    width: size,
    height: size,
    child: Tooltip(
      message: tooltip,
      child: Material(
        color: Colors.white,
        shape: const CircleBorder(side: BorderSide(color: _rowBorder)),
        child: InkWell(
          customBorder: const CircleBorder(),
          onTap: onPressed,
          child: Stack(
            alignment: Alignment.center,
            children: [
              Icon(icon, size: 22, color: staffNavy),
              if (dot)
                const Positioned(
                  top: 11,
                  right: 11,
                  child: CircleAvatar(radius: 3.5, backgroundColor: staffNavy),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _PillButton extends StatelessWidget {
  const _PillButton({super.key, required this.label, required this.onPressed});
  final String label;
  final VoidCallback onPressed;
  @override
  Widget build(BuildContext context) => Material(
    color: Colors.white,
    shape: const StadiumBorder(side: BorderSide(color: _rowBorder)),
    child: InkWell(
      customBorder: const StadiumBorder(),
      onTap: onPressed,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 38, minWidth: 64),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          child: Center(
            widthFactor: 1,
            child: Text(
              label,
              style: const TextStyle(
                fontSize: 15,
                fontWeight: FontWeight.w600,
                color: staffNavy,
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

class _TagChip extends StatelessWidget {
  const _TagChip({
    super.key,
    required this.label,
    required this.selected,
    required this.onTap,
    this.removable = false,
  });
  final String label;
  final bool selected, removable;
  final VoidCallback onTap;
  @override
  Widget build(BuildContext context) => Semantics(
    button: true,
    selected: selected,
    child: Material(
      color: selected ? Colors.black : Colors.white,
      shape: StadiumBorder(
        side: BorderSide(color: selected ? Colors.black : _rowBorder),
      ),
      child: InkWell(
        customBorder: const StadiumBorder(),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 13, vertical: 6),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 12.5,
                  fontWeight: FontWeight.w600,
                  color: selected ? Colors.white : staffNavy,
                ),
              ),
              if (removable) ...[
                const SizedBox(width: 4),
                const Icon(
                  Icons.close,
                  size: 14,
                  color: staffNavy,
                  semanticLabel: 'Clear filter',
                ),
              ],
            ],
          ),
        ),
      ),
    ),
  );
}

class _UsersSkeleton extends StatelessWidget {
  const _UsersSkeleton();
  @override
  Widget build(BuildContext context) => ListView(
    key: const ValueKey('vm-users-skeleton'),
    padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
    physics: const NeverScrollableScrollPhysics(),
    children: [
      for (var i = 0; i < 5; i++)
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: Container(
            height: 70,
            padding: const EdgeInsets.symmetric(horizontal: 14),
            decoration: BoxDecoration(
              color: Colors.white,
              borderRadius: BorderRadius.circular(14),
              border: Border.all(color: _rowBorder),
            ),
            child: Row(
              children: [
                const CircleAvatar(
                  radius: 21,
                  backgroundColor: staffAvatarBackground,
                ),
                const SizedBox(width: 12),
                Column(
                  mainAxisAlignment: MainAxisAlignment.center,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Container(
                      width: 130,
                      height: 12,
                      decoration: BoxDecoration(
                        color: const Color(0xFFF1F0EC),
                        borderRadius: BorderRadius.circular(6),
                      ),
                    ),
                    const SizedBox(height: 8),
                    Container(
                      width: 80,
                      height: 10,
                      decoration: BoxDecoration(
                        color: const Color(0xFFF5F4F1),
                        borderRadius: BorderRadius.circular(5),
                      ),
                    ),
                  ],
                ),
              ],
            ),
          ),
        ),
    ],
  );
}

/// Long-press preview + action menu. Loads the profile on open for the
/// WORK PROFILE preview; never offers removal from the team.
class _QuickActionsOverlay extends StatelessWidget {
  const _QuickActionsOverlay({
    required this.user,
    required this.profile,
    required this.actions,
  });
  final DirectoryUser user;
  final Future<VenueStaffProfile> profile;
  final List<(_QuickAction, String, IconData)> actions;
  @override
  Widget build(BuildContext context) => SafeArea(
    child: GestureDetector(
      behavior: HitTestBehavior.translucent,
      onTap: () => Navigator.pop(context),
      child: Align(
        alignment: Alignment.topCenter,
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(24, 32, 24, 24),
          child: GestureDetector(
            // Taps inside the cards must not dismiss.
            onTap: () {},
            child: Material(
              key: const ValueKey('vm-quick-actions'),
              type: MaterialType.transparency,
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 420),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    Container(
                      padding: const EdgeInsets.all(18),
                      decoration: BoxDecoration(
                        color: Colors.white,
                        borderRadius: BorderRadius.circular(24),
                      ),
                      child: FutureBuilder<VenueStaffProfile>(
                        future: profile,
                        builder: (context, snapshot) => Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: [
                            Center(
                              child: Container(
                                padding: const EdgeInsets.symmetric(
                                  horizontal: 14,
                                  vertical: 6,
                                ),
                                decoration: BoxDecoration(
                                  color: const Color(0xFFE5E4E0),
                                  borderRadius: BorderRadius.circular(999),
                                ),
                                child: Text(
                                  user.name.toUpperCase(),
                                  style: const TextStyle(
                                    fontSize: 15,
                                    fontWeight: FontWeight.w800,
                                    letterSpacing: .4,
                                    color: staffNavy,
                                  ),
                                ),
                              ),
                            ),
                            const SizedBox(height: 14),
                            Row(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Expanded(
                                  child: Column(
                                    crossAxisAlignment:
                                        CrossAxisAlignment.start,
                                    children: [
                                      if ((snapshot.data?.jobRoleName ??
                                              user.jobRoleName) !=
                                          null)
                                        Text(
                                          (snapshot.data?.jobRoleName ??
                                              user.jobRoleName)!,
                                          style: const TextStyle(
                                            fontSize: 14,
                                            color: staffMuted,
                                          ),
                                        ),
                                      if (snapshot.hasData)
                                        StaffWorkProfile(
                                          profile: snapshot.data!,
                                        )
                                      else if (snapshot.hasError)
                                        Padding(
                                          padding: const EdgeInsets.only(
                                            top: 14,
                                          ),
                                          child: Text(
                                            staffErrorMessage(
                                              snapshot.error!,
                                              action: 'view',
                                            ),
                                            style: const TextStyle(
                                              color: ScheduleTokens.errorText,
                                            ),
                                          ),
                                        )
                                      else
                                        const Padding(
                                          padding: EdgeInsets.only(top: 18),
                                          child: LinearProgressIndicator(
                                            minHeight: 3,
                                          ),
                                        ),
                                    ],
                                  ),
                                ),
                                const SizedBox(width: 12),
                                StaffInitialsSquare(name: user.name, size: 112),
                              ],
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                    FutureBuilder<VenueStaffProfile>(
                      future: profile,
                      builder: (context, snapshot) {
                        final gone =
                            snapshot.hasError && isNotAssigned(snapshot.error!);
                        return Align(
                          alignment: Alignment.centerLeft,
                          child: FractionallySizedBox(
                            widthFactor: 0.7,
                            child: Container(
                              padding: const EdgeInsets.symmetric(vertical: 6),
                              decoration: BoxDecoration(
                                color: Colors.white,
                                borderRadius: BorderRadius.circular(16),
                              ),
                              clipBehavior: Clip.antiAlias,
                              child: Column(
                                mainAxisSize: MainAxisSize.min,
                                children: [
                                  for (final action in actions)
                                    InkWell(
                                      key: ValueKey(
                                        'vm-quick-action-${action.$1.name}',
                                      ),
                                      onTap: gone
                                          ? null
                                          : () => Navigator.pop(
                                              context,
                                              action.$1,
                                            ),
                                      child: Padding(
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 16,
                                          vertical: 9,
                                        ),
                                        child: Row(
                                          children: [
                                            Icon(
                                              action.$3,
                                              size: 21,
                                              color: gone
                                                  ? staffMuted
                                                  : staffNavy,
                                            ),
                                            const SizedBox(width: 12),
                                            Flexible(
                                              child: Text(
                                                action.$2,
                                                style: TextStyle(
                                                  fontSize: 16,
                                                  fontWeight: FontWeight.w500,
                                                  color: gone
                                                      ? staffMuted
                                                      : staffNavy,
                                                ),
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
                        );
                      },
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}
