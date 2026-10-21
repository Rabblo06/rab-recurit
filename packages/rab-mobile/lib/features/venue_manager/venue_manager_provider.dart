import 'sent_shift.dart';
import 'package:flutter/foundation.dart';
import '../../core/api/api_client.dart';
import '../../core/models/offer.dart';
import '../../core/theme/shift_visual_style.dart';
import '../../core/theme/display_labels.dart';
import 'confirmed_staff.dart';
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

/// One row of `GET /staff/venue-directory` — only Staff the Initial Manager
/// explicitly assigned to this Venue Manager. There is no discovery pool and
/// no client-side team mutation: the VM can never add or remove members.
class DirectoryUser {
  DirectoryUser.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      name = '${json['firstName'] ?? ''} ${json['lastName'] ?? ''}'.trim(),
      status = json['employmentStatus'] as String? ?? '',
      jobRoleName = _blankToNull(json['jobRoleName']),
      isFavourite = json['isFavourite'] == true,
      isEmergency = json['isEmergency'] == true,
      // Real, backend-derived (see AvailabilityService) — present only
      // when the caller asked for a specific shift window; `null` means
      // "not evaluated for a window," never "unavailable." Employment
      // eligibility (deactivated/suspended/pending-invite) never even
      // reaches this model — those accounts are excluded server-side
      // before this list is built at all.
      available = json['available'] as bool?;
  DirectoryUser._(
    this.id,
    this.name,
    this.status,
    this.jobRoleName,
    this.isFavourite,
    this.isEmergency,
    this.available,
  );
  final String id, name, status;
  final String? jobRoleName;
  final bool isFavourite, isEmergency;
  final bool? available;

  /// Applies the server's confirmed tag state (never an optimistic guess).
  DirectoryUser withTags({bool? isFavourite, bool? isEmergency}) =>
      DirectoryUser._(
        id,
        name,
        status,
        jobRoleName,
        isFavourite ?? this.isFavourite,
        isEmergency ?? this.isEmergency,
        available,
      );
}

String? _blankToNull(Object? value) {
  final text = value is String ? value.trim() : null;
  return text == null || text.isEmpty ? null : text;
}

/// `GET /staff/venue-directory/:staffId` — every optional field is rendered
/// only when the server provides it. There are no review ratings in the
/// backend, so this model deliberately has no rating field.
class VenueStaffProfile {
  VenueStaffProfile.fromJson(Map<String, dynamic> json)
    : id = json['id'] as String,
      firstName = json['firstName'] as String? ?? '',
      lastName = json['lastName'] as String? ?? '',
      jobRoleName = _blankToNull(json['jobRoleName']),
      employmentType = _blankToNull(json['employmentType']),
      yearsExperience = (json['yearsExperience'] as num?)?.toInt(),
      skills = [
        for (final s in (json['skills'] as List?) ?? const [])
          if (_blankToNull(s) != null) _blankToNull(s)!,
      ],
      availableDays = {
        for (final d in (json['availableDays'] as List?) ?? const [])
          if (d is String) d,
      },
      preferredShiftTimes = _blankToNull(json['preferredShiftTimes']),
      maxHoursPerWeek = (json['maxHoursPerWeek'] as num?)?.toInt(),
      isFavourite = json['isFavourite'] == true,
      isEmergency = json['isEmergency'] == true;
  final String id, firstName, lastName;
  final String? jobRoleName, employmentType, preferredShiftTimes;
  final int? yearsExperience, maxHoursPerWeek;
  final List<String> skills;

  /// Subset of 'Monday'..'Sunday' exactly as the server sent it.
  final Set<String> availableDays;
  bool isFavourite, isEmergency;
  String get name => '$firstName $lastName'.trim();
}

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

  /// Sent Shifts "All" view: every submitted request that is NOT expired (server `/shifts/sent?view=all`).
  List<SentShift> sentShifts = [];

  /// Server tab counts for Sent Shifts: all / pending / accepted / confirmed / declined / expired, plus `submitted` —
  /// the number of distinct requests this Venue Manager submitted (one request = one, however many staff it reached).
  Map<String, int> sentCounts = {};
  int? get sentSubmitted => sentCounts['submitted'];

  /// One Sent Shifts tab, filtered and paginated by the server (never by the phone).
  Future<List<SentShift>> loadSentView(String view) async =>
      (await all('/shifts/sent?view=$view')).map(SentShift.fromJson).toList();
  List<Map<String, dynamic>> venues = [];
  List<Map<String, dynamic>> jobRoles = [];
  int? userCount;
  String? directoryError;

  /// Totals of the server's Reports (`current`) and History (`history`) lists; null until loaded or if unavailable.
  int? currentReportCount;
  int? historyReportCount;
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

  /// Presentation filter over server-scoped shifts, never an authorization rule.
  /// Past offers/requests alone are not completed staffing activity.
  List<VenueEvent> history({DateTime? now}) {
    final cutoff = now ?? DateTime.now();
    return events
        .where(
          (e) =>
              !e.end.isAfter(cutoff) &&
              (e.status == 'completed' ||
                  ([
                        'confirmed',
                        'fully_filled',
                        'partially_filled',
                      ].contains(e.status) &&
                      e.filled > 0)),
        )
        .toList()
      ..sort((a, b) => b.end.compareTo(a.end));
  }

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

  /// `silent: true` — same reasoning as `AttendanceProvider.refreshActive`'s
  /// own `silent` parameter (mirrors the web Users-table fix too): the 5s
  /// Sent Shifts poll (`sent_shifts_screen.dart`) and the app-resume refresh
  /// (`venue_manager_screens.dart`) both already have good data on screen,
  /// and flipping `loading` back to `true` for either flashed every screen
  /// built on this provider back to its loading state every few seconds and
  /// on every unlock. A real first load or a user-initiated action (sending
  /// a shift, pull-to-refresh) still shows loading as before.
  Future<void> refresh({bool silent = false}) async {
    final generation = ++_generation;
    if (!silent) loading = true;
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
        all('/shifts/sent?view=all'),
      ]);
      final sentMeta =
          await api.get('/shifts/sent?view=all&limit=1')
              as Map<String, dynamic>;
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
      sentShifts = results[4].map(SentShift.fromJson).toList();
      sentCounts = {
        for (final e in ((sentMeta['counts'] as Map?) ?? const {}).entries)
          e.key as String: (e.value as num).toInt(),
      };
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
      if (allows('report.view')) {
        try {
          final counts = await Future.wait([
            loadReports('current', limit: 1),
            loadReports('history', limit: 1),
          ]);
          if (_disposed || generation != _generation) return;
          currentReportCount = counts[0].total;
          historyReportCount = counts[1].total;
        } catch (_) {
          currentReportCount = null;
          historyReportCount = null;
        }
      }
      updatedAt = DateTime.now();
    } catch (e) {
      if (!_disposed && generation == _generation) {
        error = _message(e);
        // Do not retain sensitive records after scope/permission changes.
        events = [];
        offers = [];
        sentShifts = [];
        sentCounts = {};
        venues = [];
        jobRoles = [];
        capabilities = {};
        userCount = null;
        currentReportCount = null;
        historyReportCount = null;
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
  /// its own staff appear unavailable for it. [tag] is `favourite` or
  /// `emergency` (server-side filter over this VM's own tags).
  Future<({List<DirectoryUser> users, int total})> searchUsers(
    String query,
    int page, {
    String? status,
    String? tag,
    DateTime? startAt,
    DateTime? endAt,
    String? excludeShiftId,
  }) async {
    assert(tag == null || tag == 'favourite' || tag == 'emergency');
    final response = await api.get(
      '/staff/venue-directory?q=${Uri.encodeQueryComponent(query)}&page=$page&limit=30'
      '${status == null ? '' : '&status=${Uri.encodeQueryComponent(status)}'}'
      '${tag == null ? '' : '&tag=${Uri.encodeQueryComponent(tag)}'}'
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

  /// 404 when the staff member is not (or no longer) assigned to this VM —
  /// callers surface that as "no longer assigned", never as a stale profile.
  Future<VenueStaffProfile> fetchStaffProfile(String staffId) async {
    final json = await api.get(
      '/staff/venue-directory/${Uri.encodeComponent(staffId)}',
    );
    return VenueStaffProfile.fromJson(Map<String, dynamic>.from(json as Map));
  }

  /// Sends only the tag(s) being changed; returns the server's confirmed
  /// state, which is what the UI then renders.
  Future<({bool isFavourite, bool isEmergency})> setStaffTags(
    String staffId, {
    bool? favourite,
    bool? emergency,
  }) async {
    if (favourite == null && emergency == null) {
      throw ArgumentError('setStaffTags needs favourite and/or emergency.');
    }
    final response = await api.patch(
      '/staff/venue-directory/${Uri.encodeComponent(staffId)}/tags',
      body: {'favourite': ?favourite, 'emergency': ?emergency},
    );
    return (
      isFavourite: response['isFavourite'] == true,
      isEmergency: response['isEmergency'] == true,
    );
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

  /// One sent request (`GET /shifts/sent/:id`, scoped server-side to this
  /// Venue Manager's own requests in their venues; 404 otherwise). Works for
  /// expired requests too, which the All list never contains.
  Future<SentShift> loadSentShift(String shiftId) async => SentShift.fromJson(
    Map<String, dynamic>.from(
      await api.get('/shifts/sent/${Uri.encodeComponent(shiftId)}') as Map,
    ),
  );

  /// The confirmed seats of ONE shift. With `report.view` they come from the
  /// shift report (assignment-level, with real attendance); a report for a
  /// different shift is refused rather than shown under this shift's header.
  /// Without it, from this shift's `manager_confirmed` offers (no attendance).
  Future<ShiftRoster> loadRoster(String shiftId) async {
    if (!allows('report.view')) return ShiftRoster.fromOffers(shiftId, offers);
    final report = await loadReport(shiftId);
    if (report.shiftId != shiftId) {
      throw StateError('The report returned belongs to another shift.');
    }
    return ShiftRoster.fromReport(report);
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

  /// Completes one seat's ATTENDANCE review (server `POST .../attendance-review`, `attendance.edit`). The server refuses
  /// (409) while the staff member is still clocked in or their clock-out is missing, and after finalisation; on success
  /// it returns the authoritative report, which the caller renders instead of any local guess.
  Future<ShiftReportDetail> reviewAttendance(
    String shiftId,
    String staffProfileId,
  ) async {
    final json = await api.post(
      '/attendance/report/shift/$shiftId/staff/$staffProfileId/attendance-review',
    );
    return ShiftReportDetail.fromJson(json as Map<String, dynamic>);
  }

  /// Fast/synchronous on the server — flips attendance to `approved` and
  /// marks the report finalised, but never blocks on PDF/email (those are
  /// the worker's job on its next tick). 409s (e.g. someone still clocked
  /// in) surface via the thrown `ApiException`.
  /// Typed sign-off: the server records the signer and time itself (`finalised_by` / `finalised_at`).
  Future<void> finaliseReport(
    String shiftId, {
    required String signedOffName,
    required bool breakConfirmed,
  }) => api.patch(
    '/attendance/report/shift/$shiftId/finalise',
    body: {'signedOffName': signedOffName, 'breakConfirmed': breakConfirmed},
  );

  /// Reports (`current`) / History (`history`) — filtered server-side against DB time (five-hour policy).
  Future<({List<ReportSummary> rows, int total})> loadReports(
    String bucket, {
    int page = 1,
    int limit = 30,
  }) async {
    assert(bucket == 'current' || bucket == 'history');
    final json =
        await api.get(
              '/attendance/report/shifts?bucket=$bucket&page=$page&limit=$limit',
            )
            as Map<String, dynamic>;
    return (
      rows: (json['data'] as List)
          .map((r) => ReportSummary.fromJson(r as Map<String, dynamic>))
          .toList(),
      total: (json['total'] as num).toInt(),
    );
  }

  Future<({StaffReview? review, bool editable})> loadReview(
    String shiftId,
    String staffProfileId,
  ) async {
    final json =
        await api.get(
              '/attendance/report/shift/$shiftId/reviews/$staffProfileId',
            )
            as Map<String, dynamic>;
    return (
      review: json['review'] == null
          ? null
          : StaffReview.fromJson(json['review'] as Map<String, dynamic>),
      editable: json['editable'] as bool? ?? false,
    );
  }

  Future<StaffReview> saveReview(
    String shiftId,
    String staffProfileId, {
    required Map<String, int> ratings,
    String? feedback,
  }) async {
    final json = await api.put(
      '/attendance/report/shift/$shiftId/reviews/$staffProfileId',
      body: {
        ...ratings,
        if (feedback != null && feedback.trim().isNotEmpty)
          'feedback': feedback,
      },
    );
    return StaffReview.fromJson(json as Map<String, dynamic>);
  }

  /// A report PDF through `GET /files/:id/download` (ReportFilePolicy-authorised; a presigned storage redirect is
  /// followed without the bearer token — see `ApiClient.downloadFile`).
  Future<DownloadedFile> downloadReportDocument(String fileId) =>
      api.downloadFile('/files/$fileId/download');

  static String _message(Object e) => userMessageFor(
    e,
    fallback: 'Unable to load venue data. Please try again.',
  );
  @override
  void dispose() {
    _disposed = true;
    _generation++;
    super.dispose();
  }
}
