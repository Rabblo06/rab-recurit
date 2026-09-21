import 'dart:async';
import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../../core/theme/schedule_tokens.dart';
import 'venue_manager_provider.dart';
import 'venue_manager_screens.dart';

const employmentFilters = <String?, String>{
  null: 'All',
  'active': 'Active',
  'pending_compliance': 'Pending compliance',
  'inactive': 'Inactive',
  'suspended': 'Suspended',
};

/// Small pill marking a Staff account created within [newUserWindow] — see
/// that constant and [isNewUser] in venue_manager_provider.dart. Presentation
/// only: never an account-status indicator, so it always renders alongside
/// (never instead of) the employment-status subtitle.
class _NewBadge extends StatelessWidget {
  const _NewBadge();
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
    decoration: BoxDecoration(
      color: ScheduleTokens.peach,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(
      'NEW',
      style: TextStyle(
        fontSize: 9,
        fontWeight: FontWeight.w700,
        letterSpacing: 0.4,
        color: ScheduleTokens.ink.withValues(alpha: 0.75),
      ),
    ),
  );
}

/// A general roster browse has no specific shift in mind — "available for
/// what?" only has a real answer when checked against *a* window, so these
/// two screens ask the server for a real, backend-derived "busy right now"
/// signal (a minimal now→now+1min window) rather than showing no signal at
/// all or fabricating one client-side. [VenueSelectStaffScreen] (launched
/// from Send Shift, which always knows the real shift window) passes that
/// actual window instead — a meaningfully different, more useful check.
DateTime get _rightNow => DateTime.now();

/// Real, backend-derived Available/Not Available — never an internal
/// account-state label (suspended/deactivated/pending-invite accounts
/// never reach this list at all; see `StaffService.venueStaffPool`'s own
/// doc comment). The Venue Manager sees only these two words, matching the
/// product rule that they don't need to know *why* someone isn't
/// available for a given window.
class _AvailabilityBadge extends StatelessWidget {
  const _AvailabilityBadge({required this.available});
  final bool available;
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 4),
    decoration: BoxDecoration(
      color: available ? ScheduleTokens.homeMint : ScheduleTokens.dangerSoft,
      borderRadius: BorderRadius.circular(20),
    ),
    child: Text(
      available ? 'Available' : 'Not Available',
      style: TextStyle(
        fontSize: 10.5,
        fontWeight: FontWeight.w600,
        color: available ? const Color(0xFF2F7A5C) : ScheduleTokens.danger,
      ),
    ),
  );
}

class VenueUsersScreen extends StatelessWidget {
  const VenueUsersScreen({super.key});
  @override
  Widget build(BuildContext context) => _StaffBrowser(
    mode: _DirectoryMode.directory,
    startAt: _rightNow,
    endAt: _rightNow.add(const Duration(minutes: 1)),
  );
}

class VenueAllUsersScreen extends StatelessWidget {
  const VenueAllUsersScreen({super.key});
  @override
  Widget build(BuildContext context) => _StaffBrowser(
    mode: _DirectoryMode.all,
    startAt: _rightNow,
    endAt: _rightNow.add(const Duration(minutes: 1)),
  );
}

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
  Widget build(BuildContext context) => _StaffBrowser(
    mode: _DirectoryMode.selection,
    initialSelection: initialSelection,
    startAt: startAt,
    endAt: endAt,
    excludeShiftId: excludeShiftId,
  );
}

enum _DirectoryMode { directory, all, selection }

class _StaffBrowser extends StatefulWidget {
  const _StaffBrowser({
    required this.mode,
    this.initialSelection = const {},
    this.startAt,
    this.endAt,
    this.excludeShiftId,
  });
  final _DirectoryMode mode;
  final Map<String, DirectoryUser> initialSelection;
  final DateTime? startAt, endAt;
  final String? excludeShiftId;
  @override
  State<_StaffBrowser> createState() => _StaffBrowserState();
}

class _StaffBrowserState extends State<_StaffBrowser> {
  final search = TextEditingController();
  Timer? debounce;
  late final selected = Map<String, DirectoryUser>.of(widget.initialSelection);
  List<DirectoryUser> users = [];
  int page = 1, total = 0, generation = 0;
  bool loading = true;
  String? error, status;
  final adding = <String>{};
  final addedHere = <String>{};
  DateTime? scope;
  bool get selecting => widget.mode == _DirectoryMode.selection;
  String get title => switch (widget.mode) {
    _DirectoryMode.directory => 'Users',
    _DirectoryMode.all => 'All Users',
    _DirectoryMode.selection => 'Select Staff',
  };
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
      error = null;
      if (!more) {
        page = 1;
        users = [];
      }
    });
    try {
      // All Users is the eligible pool; Users and selection are saved team members.
      final provider = context.read<VenueManagerProvider>();
      final performSearch = widget.mode == _DirectoryMode.all
          ? provider.searchAllUsers
          : provider.searchUsers;
      final result = await performSearch(
        search.text,
        more ? page + 1 : 1,
        status: status,
        startAt: widget.startAt,
        endAt: widget.endAt,
        excludeShiftId: widget.excludeShiftId,
      );
      if (!mounted || stamp != generation) return;
      setState(() {
        users = [if (more) ...users, ...result.users];
        total = result.total;
        if (more) page++;
        loading = false;
      });
    } catch (_) {
      if (mounted && stamp == generation) {
        setState(() {
          loading = false;
          error = 'Unable to load staff. Please try again.';
        });
      }
    }
  }

  void filter(String? next) {
    status = next;
    load();
  }

  Future<void> filters() async {
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (sheet) => SafeArea(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            const ListTile(title: Text('Employment status')),
            for (final entry in employmentFilters.entries)
              ListTile(
                title: Text(entry.value),
                trailing: status == entry.key ? const Icon(Icons.check) : null,
                onTap: () {
                  Navigator.pop(sheet);
                  filter(entry.key);
                },
              ),
          ],
        ),
      ),
    );
  }

  Future<void> add() async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute(builder: (_) => const VenueAllUsersScreen()),
    );
    if (mounted) load();
  }

  Future<void> use(DirectoryUser user) async {
    if (selecting) {
      // A client-side UX guard only — never the authorization boundary.
      // Someone already selected before their overlapping shift was
      // confirmed elsewhere can still be removed; they just can't be
      // freshly added while known to be unavailable. The real check
      // happens again server-side at submission regardless.
      if (user.available == false && !selected.containsKey(user.id)) return;
      setState(() {
        if (selected.containsKey(user.id)) {
          selected.remove(user.id);
        } else if (selected.length < 100) {
          selected[user.id] = user;
        }
      });
      return;
    }
    if (widget.mode == _DirectoryMode.directory) {
      vmPush(context, VenueStaffDetail(user: user));
      return;
    }
    if (user.added || addedHere.contains(user.id) || adding.contains(user.id)) {
      return;
    }
    setState(() => adding.add(user.id));
    try {
      await context.read<VenueManagerProvider>().addTeamMember(user.id);
      if (mounted) setState(() => addedHere.add(user.id));
    } catch (_) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Unable to add this staff member. Please try again.'),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => adding.remove(user.id));
    }
  }

  @override
  Widget build(BuildContext context) {
    final p = context.watch<VenueManagerProvider>();
    return Scaffold(
      backgroundColor: ScheduleTokens.homeBackground,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
              child: Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  IconButton.filledTonal(
                    style: IconButton.styleFrom(backgroundColor: Colors.white),
                    tooltip: 'Back',
                    onPressed: () => Navigator.maybePop(context),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  if (widget.mode == _DirectoryMode.directory)
                    IconButton.filled(
                      style: IconButton.styleFrom(
                        backgroundColor: ScheduleTokens.accent,
                      ),
                      tooltip: selecting ? 'Browse all users' : 'All Users',
                      onPressed: add,
                      icon: const Icon(Icons.add),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Text(title, style: ScheduleTokens.heading),
            ),
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 24),
              child: Row(
                children: [
                  Expanded(
                    child: TextField(
                      controller: search,
                      style: ScheduleTokens.body,
                      decoration: InputDecoration(
                        hintText: 'Search User',
                        isDense: true,
                        prefixIcon: const Icon(Icons.search, size: 18),
                        filled: true,
                        fillColor: Colors.white,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(28),
                          borderSide: BorderSide.none,
                        ),
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
                  const SizedBox(width: 8),
                  IconButton.filledTonal(
                    style: IconButton.styleFrom(backgroundColor: Colors.white),
                    tooltip: 'Filter users',
                    onPressed: filters,
                    icon: const Icon(Icons.tune, size: 18),
                  ),
                ],
              ),
            ),
            if (widget.mode != _DirectoryMode.all || status != null)
              Padding(
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 8,
                ),
                child: Wrap(
                  spacing: 6,
                  runSpacing: 4,
                  children: [
                    for (final key in <String?>[
                      null,
                      'active',
                      'pending_compliance',
                      if (status == 'inactive' || status == 'suspended') status,
                    ])
                      ChoiceChip(
                        label: Text(
                          employmentFilters[key]!,
                          style: TextStyle(
                            fontSize: 11,
                            color: status == key
                                ? Colors.white
                                : ScheduleTokens.ink,
                          ),
                        ),
                        selected: status == key,
                        showCheckmark: false,
                        selectedColor: ScheduleTokens.accent,
                        backgroundColor: Colors.white,
                        visualDensity: VisualDensity.compact,
                        onSelected: (_) => filter(key),
                      ),
                  ],
                ),
              ),
            const SizedBox(height: 8),
            Expanded(
              child: p.error != null
                  ? VmError(message: p.error!, retry: p.refresh)
                  : !p.loading && !p.allows('staff.view')
                  ? const Center(child: Text('Staff viewing is not permitted.'))
                  : error != null
                  ? VmError(message: error!, retry: load)
                  : loading && users.isEmpty || p.loading
                  ? ListView(
                      padding: const EdgeInsets.all(24),
                      children: List.generate(
                        5,
                        (_) => const Padding(
                          padding: EdgeInsets.only(bottom: 10),
                          child: ListTile(
                            tileColor: Colors.white,
                            leading: CircleAvatar(
                              backgroundColor: Color(0xFFE9E9ED),
                            ),
                            title: LinearProgressIndicator(minHeight: 6),
                          ),
                        ),
                      ),
                    )
                  : RefreshIndicator(
                      onRefresh: load,
                      child: ListView(
                        padding: const EdgeInsets.fromLTRB(24, 8, 24, 24),
                        physics: const AlwaysScrollableScrollPhysics(),
                        children: [
                          if (users.isEmpty)
                            Padding(
                              padding: const EdgeInsets.symmetric(vertical: 32),
                              child: Text(
                                search.text.isNotEmpty || status != null
                                    ? 'No staff match these filters.'
                                    : widget.mode == _DirectoryMode.directory
                                    ? 'No staff added yet.'
                                    : 'No active staff available.',
                                style: ScheduleTokens.body,
                                textAlign: TextAlign.center,
                              ),
                            ),
                          for (final u in users)
                            Padding(
                              padding: const EdgeInsets.only(bottom: 10),
                              child: Container(
                                decoration: BoxDecoration(
                                  color: Colors.white,
                                  borderRadius: BorderRadius.circular(18),
                                  boxShadow: ScheduleTokens.homeShadows,
                                ),
                                child: ListTile(
                                  dense: true,
                                  minVerticalPadding: 8,
                                  contentPadding: const EdgeInsets.symmetric(
                                    horizontal: 12,
                                  ),
                                  shape: RoundedRectangleBorder(
                                    borderRadius: BorderRadius.circular(18),
                                  ),
                                  leading: selecting
                                      ? Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            Checkbox(
                                              value: selected.containsKey(u.id),
                                              // Not Available -> checkbox
                                              // disabled, cannot be freshly
                                              // selected. `null` (no window
                                              // evaluated) is treated as
                                              // selectable, never as a
                                              // silent block.
                                              onChanged:
                                                  u.available == false &&
                                                      !selected.containsKey(
                                                        u.id,
                                                      )
                                                  ? null
                                                  : (_) => use(u),
                                            ),
                                            CircleAvatar(
                                              radius: 16,
                                              backgroundColor:
                                                  ScheduleTokens.lavender,
                                              child: Text(
                                                initials(u.name),
                                                style: const TextStyle(
                                                  fontSize: 11,
                                                ),
                                              ),
                                            ),
                                          ],
                                        )
                                      : CircleAvatar(
                                          radius: 16,
                                          backgroundColor: const Color(
                                            0xFFE1E1E4,
                                          ),
                                          child: Text(
                                            initials(u.name),
                                            style: const TextStyle(
                                              fontSize: 11,
                                            ),
                                          ),
                                        ),
                                  title: Row(
                                    mainAxisSize: MainAxisSize.min,
                                    children: [
                                      Flexible(
                                        child: Text(
                                          u.name,
                                          overflow: TextOverflow.ellipsis,
                                          style: ScheduleTokens.body.copyWith(
                                            fontWeight: FontWeight.w600,
                                            fontSize: 13,
                                          ),
                                        ),
                                      ),
                                      if (isNewUser(u.createdAt)) ...[
                                        const SizedBox(width: 6),
                                        const _NewBadge(),
                                      ],
                                    ],
                                  ),
                                  subtitle:
                                      selecting ||
                                          widget.mode == _DirectoryMode.all
                                      ? Text(
                                          employmentFilters[u.status] ??
                                              u.status,
                                          style: ScheduleTokens.label,
                                        )
                                      : null,
                                  trailing: selecting
                                      ? (u.available == null
                                            ? null
                                            : _AvailabilityBadge(
                                                available: u.available!,
                                              ))
                                      : Row(
                                          mainAxisSize: MainAxisSize.min,
                                          children: [
                                            if (u.available != null) ...[
                                              _AvailabilityBadge(
                                                available: u.available!,
                                              ),
                                              const SizedBox(width: 8),
                                            ],
                                            IconButton(
                                              tooltip:
                                                  widget.mode ==
                                                      _DirectoryMode.directory
                                                  ? 'View staff'
                                                  : (u.added ||
                                                            addedHere.contains(
                                                              u.id,
                                                            )
                                                        ? 'Added'
                                                        : 'Add staff'),
                                              onPressed:
                                                  widget.mode ==
                                                          _DirectoryMode.all &&
                                                      (u.added ||
                                                          addedHere.contains(
                                                            u.id,
                                                          ) ||
                                                          adding.contains(u.id))
                                                  ? null
                                                  : () => use(u),
                                              icon: CircleAvatar(
                                                radius: 12,
                                                backgroundColor:
                                                    ScheduleTokens.accent,
                                                child: Icon(
                                                  widget.mode ==
                                                          _DirectoryMode
                                                              .directory
                                                      ? Icons.north_east
                                                      : (u.added ||
                                                                addedHere
                                                                    .contains(
                                                                      u.id,
                                                                    )
                                                            ? Icons.check
                                                            : Icons.add),
                                                  size: 16,
                                                  color: Colors.white,
                                                ),
                                              ),
                                            ),
                                          ],
                                        ),
                                  onTap: () => use(u),
                                ),
                              ),
                            ),
                          if (users.length < total)
                            TextButton(
                              onPressed: loading
                                  ? null
                                  : () => load(more: true),
                              child: Text(loading ? 'Loading…' : 'Load more'),
                            ),
                        ],
                      ),
                    ),
            ),
            if (selecting)
              SafeArea(
                top: false,
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(
                    children: [
                      Text(
                        '${selected.length} selected',
                        style: ScheduleTokens.label,
                      ),
                      const SizedBox(height: 8),
                      Row(
                        children: [
                          Expanded(
                            child: FilledButton(
                              onPressed: () => Navigator.pop(context),
                              child: const Text('Cancel'),
                            ),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: FilledButton(
                              onPressed: () => Navigator.pop(
                                context,
                                Map<String, DirectoryUser>.of(selected),
                              ),
                              child: const Text('Submit'),
                            ),
                          ),
                        ],
                      ),
                    ],
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

class VenueStaffDetail extends StatelessWidget {
  const VenueStaffDetail({super.key, required this.user});
  final DirectoryUser user;
  @override
  Widget build(BuildContext context) => VmPage(
    title: 'Staff details',
    child: FutureBuilder(
      future: context.read<VenueManagerProvider>().searchUsers(user.name, 1),
      builder: (context, snapshot) {
        if (snapshot.connectionState != ConnectionState.done) {
          return const Center(child: CircularProgressIndicator());
        }
        final current = snapshot.data?.users
            .where((u) => u.id == user.id)
            .firstOrNull;
        if (current == null) {
          return const Center(child: Text('This staff member is unavailable.'));
        }
        return ListView(
          padding: const EdgeInsets.all(24),
          children: [
            CircleAvatar(
              radius: 32,
              backgroundColor: ScheduleTokens.lavender,
              child: Text(initials(current.name)),
            ),
            const SizedBox(height: 20),
            Text(
              current.name,
              style: ScheduleTokens.heading,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 12),
            Text(
              employmentFilters[current.status] ?? current.status,
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            const Text(
              'Visible through your assigned venues.',
              style: ScheduleTokens.label,
            ),
          ],
        );
      },
    ),
  );
}
