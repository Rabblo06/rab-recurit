import 'package:flutter/foundation.dart';
import '../../core/api/api_client.dart';
import '../../core/models/offer.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/theme/display_labels.dart';
import 'shift_report.dart';

class VenueEvent implements ShiftDeckRecord {
  VenueEvent(this.json, {required String role, required this.venue})
    : role = displayRoleName(role);
  final Map<String, dynamic> json;
  final String role, venue;
  @override
  String get id => json['id'] as String;
  @override
  String get shiftId => id;
  String get createdBy => json['createdBy'] as String? ?? '';
  String get address => json['address'] as String? ?? '';
  String get notes => json['notes'] as String? ?? '';
  String get status => json['status'] as String;
  DateTime get start => DateTime.parse(json['startsAt'] as String).toLocal();
  DateTime get end => DateTime.parse(json['endsAt'] as String).toLocal();
  int get required => json['requiredCount'] as int;
  int get filled => json['filledCount'] as int;
  int get vacancies => (required - filled).clamp(0, required);
}

class DirectoryUser {
  DirectoryUser.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      name = '${json['firstName']} ${json['lastName']}'.trim(),
      status = json['employmentStatus'] as String,
      added = json['added'] == true,
      email = json['email'] as String?,
      staffRef = json['staffRef'] as String?,
      createdAt = json['createdAt'] == null
          ? null
          : DateTime.parse(json['createdAt'] as String),
      // Real, backend-derived (see AvailabilityService) — present only
      // when the caller asked for a specific shift window; `null` means
      // "not evaluated for a window," never "unavailable." Employment
      // eligibility (deactivated/suspended/pending-invite) never even
      // reaches this model — those accounts are excluded server-side
      // before this list is built at all.
      available = json['available'] as bool?;
  final String id, name, status;
  final bool added;
  final String? email, staffRef;
  final DateTime? createdAt;
  final bool? available;
}

/// Single source of truth for the "NEW" badge shown on a just-created Staff
/// account — presentation-only (no `isNew` column anywhere; the account's
/// real `createdAt` is the only thing compared). Reused by every widget that
/// renders a [DirectoryUser] row so the 7-day window can never drift between
/// them. `createdAt` is the server's own timestamp (UTC on the wire,
/// converted to local by [DateTime.parse]), compared against the device's
/// current time — the same trust boundary this app's other relative-time
/// display (`timeAgo`) already uses; nothing payroll/compliance-sensitive
/// depends on this, unlike the client-driven-timer case CLAUDE.md warns
/// against.
const newUserWindow = Duration(days: 7);
bool isNewUser(DateTime? createdAt) =>
    createdAt != null && DateTime.now().difference(createdAt) < newUserWindow;

/// Consumes the existing scoped APIs using the authenticated session client.
/// No venue, organisation or workspace selectors are sent by this provider.
class VenueManagerProvider extends ChangeNotifier {
  VenueManagerProvider(this.api, this.userId);
  final ApiClient api;
  final String userId;
  bool loading = true;
  String? error;
  DateTime? updatedAt;
  Map<String, dynamic> capabilities = {};
  List<VenueEvent> events = [];
  List<OfferSummary> offers = [];
  List<Map<String, dynamic>> venues = [];
  List<Map<String, dynamic>> jobRoles = [];
  int? userCount;
  String? directoryError;
  bool _disposed = false;
  int _generation = 0;
  bool allows(String permission) => capabilities[permission] == true;
  ShiftVisualStyle style(VenueEvent event) =>
      ShiftVisualStyle.forShift(event.shiftId);
  List<VenueEvent> get upcoming => events
      .where(
        (e) =>
            e.end.isAfter(DateTime.now()) &&
            e.status != 'completed' &&
            e.status != 'cancelled' &&
            e.status != 'draft',
      )
      .toList();
  List<OfferSummary> get confirmed =>
      offers.where((o) => o.status == 'manager_confirmed').toList();
  int get confirmedPeople =>
      confirmed.map((o) => o.staffProfileId).toSet().length;
  List<OfferSummary> team(VenueEvent e) =>
      confirmed.where((o) => o.shiftId == e.id).toList();
  bool canSend(VenueEvent e) {
    final current = events.where((record) => record.id == e.id).firstOrNull;
    return !loading &&
        error == null &&
        current != null &&
        allows('offer.send') &&
        current.createdBy == userId &&
        ['open', 'offered', 'partially_filled'].contains(current.status) &&
        current.vacancies > 0 &&
        current.end.isAfter(DateTime.now());
  }

  Future<List<Map<String, dynamic>>> all(String path) async {
    final result = <Map<String, dynamic>>[];
    for (var page = 1; ; page++) {
      final response = await api.get(
        '$path${path.contains('?') ? '&' : '?'}page=$page&limit=100',
      );
      final rows = response is List ? response : response['data'] as List;
      result.addAll(rows.cast<Map<String, dynamic>>());
      if (response is List || result.length >= (response['total'] as int)) {
        break;
      }
      if (rows.isEmpty) {
        throw StateError('The list changed while loading. Please refresh.');
      }
    }
    return result;
  }

  Future<void> refresh() async {
    final generation = ++_generation;
    loading = true;
    error = null;
    directoryError = null;
    notifyListeners();
    try {
      final caps = Map<String, dynamic>.from(
        await api.get('/auth/capabilities') as Map,
      );
      if (caps['schedule.view'] != true || caps['venue.view'] != true) {
        throw ApiException(403, 'Your account cannot view venue schedules.');
      }
      final results = await Future.wait([
        all('/shifts'),
        all('/venues'),
        all('/job-roles'),
        all('/offers'),
      ]);
      if (_disposed || generation != _generation) return;
      capabilities = caps;
      venues = results[1];
      jobRoles = results[2];
      final venueNames = {for (final v in venues) v['id']: v['name'] as String};
      final roles = {for (final r in results[2]) r['id']: r['name'] as String};
      events =
          results[0]
              .map(
                (j) => VenueEvent(
                  j,
                  role: roles[j['jobRoleId']] ?? 'Shift',
                  venue: venueNames[j['venueId']] ?? 'Venue unavailable',
                ),
              )
              .toList()
            ..sort((a, b) => a.start.compareTo(b.start));
      ShiftVisualStyle.registerGroup(events.map((event) => event.shiftId));
      offers = results[3].map(OfferSummary.fromJson).toList();
      userCount = null;
      if (allows('staff.view')) {
        try {
          final response = await api.get('/staff/venue-directory?limit=1');
          if (_disposed || generation != _generation) return;
          userCount = response['total'] as int;
        } catch (e) {
          directoryError = _message(e);
        }
      }
      updatedAt = DateTime.now();
    } catch (e) {
      if (!_disposed && generation == _generation) {
        error = _message(e);
        // Do not retain sensitive records after scope/permission changes.
        events = [];
        offers = [];
        venues = [];
        jobRoles = [];
        capabilities = {};
        userCount = null;
      }
    } finally {
      if (!_disposed && generation == _generation) {
        loading = false;
        notifyListeners();
      }
    }
  }

  /// [startAt]/[endAt] (real UTC instants) ask the server to attach a real,
  /// bulk-computed `available` flag per row (see `AvailabilityService`) —
  /// omit both to get the directory with no availability field, matching
  /// the endpoint's own default shape. [excludeShiftId] is for editing an
  /// already-published shift, so its own existing assignment doesn't make
  /// its own staff appear unavailable for it.
  Future<({List<DirectoryUser> users, int total})> searchUsers(
    String query,
    int page, {
    String? status,
    DateTime? startAt,
    DateTime? endAt,
    String? excludeShiftId,
  }) async {
    final response = await api.get(
      '/staff/venue-directory?q=${Uri.encodeQueryComponent(query)}&page=$page&limit=30'
      '${status == null ? '' : '&status=${Uri.encodeQueryComponent(status)}'}'
      '${startAt == null ? '' : '&startAt=${Uri.encodeQueryComponent(startAt.toUtc().toIso8601String())}'}'
      '${endAt == null ? '' : '&endAt=${Uri.encodeQueryComponent(endAt.toUtc().toIso8601String())}'}'
      '${excludeShiftId == null ? '' : '&excludeShiftId=${Uri.encodeQueryComponent(excludeShiftId)}'}',
    );
    return (
      users: (response['data'] as List)
          .map((j) => DirectoryUser.fromJson(j as Map<String, dynamic>))
          .toList(),
      total: response['total'] as int,
    );
  }

  /// "All Users" — the broader Staff pool this Venue Manager is authorized
  /// to select from (`/staff/venue-directory/pool`), distinct from
  /// [searchUsers]'s "staff already assigned to my venue"
  /// (`/staff/venue-directory`). See `StaffService.venueStaffPool`'s doc
  /// comment on the server for the full scope reasoning — same shape/
  /// pagination contract as [searchUsers], just a different, wider source.
  Future<({List<DirectoryUser> users, int total})> searchAllUsers(
    String query,
    int page, {
    String? status,
    DateTime? startAt,
    DateTime? endAt,
    String? excludeShiftId,
  }) async {
    final response = await api.get(
      '/staff/venue-directory/pool?q=${Uri.encodeQueryComponent(query)}&page=$page&limit=30'
      '${status == null ? '' : '&status=${Uri.encodeQueryComponent(status)}'}'
      '${startAt == null ? '' : '&startAt=${Uri.encodeQueryComponent(startAt.toUtc().toIso8601String())}'}'
      '${endAt == null ? '' : '&endAt=${Uri.encodeQueryComponent(endAt.toUtc().toIso8601String())}'}'
      '${excludeShiftId == null ? '' : '&excludeShiftId=${Uri.encodeQueryComponent(excludeShiftId)}'}',
    );
    return (
      users: (response['data'] as List)
          .map((j) => DirectoryUser.fromJson(j as Map<String, dynamic>))
          .toList(),
      total: response['total'] as int,
    );
  }

  Future<void> addTeamMember(String staffId) async {
    await api.post('/staff/venue-directory/team/$staffId');
    await refresh();
  }

  Future<List<Map<String, dynamic>>> send(
    VenueEvent event,
    Set<String> staffIds,
  ) async {
    if (!canSend(event) || staffIds.isEmpty || staffIds.length > 100) {
      throw ApiException(
        403,
        'Offer sending is not available for this selection.',
      );
    }
    final response = await api.post(
      '/shifts/${event.id}/offers/bulk',
      body: {'staffProfileIds': staffIds.toList()},
    );
    final results = (response['results'] as List).cast<Map<String, dynamic>>();
    await refresh();
    return results;
  }

  /// Real, on-demand fetch — deliberately not part of `refresh()`'s bulk
  /// load, since per-staff attendance detail for every shift would be far
  /// more data than the roster view needs; only fetched when a Venue
  /// Manager actually opens a shift's report.
  Future<ShiftReportDetail> loadReport(String shiftId) async {
    final json =
        await api.get('/attendance/report/shift/$shiftId')
            as Map<String, dynamic>;
    return ShiftReportDetail.fromJson(json);
  }

  /// One of `clockInAt`/`clockOutAt`/`breakMinutes` — the only three fields
  /// a Venue Manager can correct (`CorrectAttendanceDto` on the server).
  /// `reason` is required server-side (`@MinLength(10)`) and every
  /// correction is audited — see `AttendanceService.correct`.
  Future<void> correctAttendance(
    String attendanceId, {
    required String field,
    required String newValue,
    required String reason,
  }) => api.post(
    '/attendance/$attendanceId/correct',
    body: {'field': field, 'newValue': newValue, 'reason': reason},
  );

  /// Fast/synchronous on the server — flips attendance to `approved` and
  /// marks the report finalised, but never blocks on PDF/email (those are
  /// the worker's job on its next tick). 409s (e.g. someone still clocked
  /// in) surface via the thrown `ApiException`.
  Future<void> finaliseReport(String shiftId) =>
      api.patch('/attendance/report/shift/$shiftId/finalise');

  static String _message(Object e) => e is ApiException
      ? e.message
      : 'Unable to load venue data. Please try again.';
  @override
  void dispose() {
    _disposed = true;
    _generation++;
    super.dispose();
  }
}
