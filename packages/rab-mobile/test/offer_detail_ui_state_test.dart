import 'package:flutter_test/flutter_test.dart';
import 'package:rab_staff/core/models/offer.dart';
import 'package:rab_staff/features/offers/offer_detail_ui_state.dart';

void main() {
  final now = DateTime(2026, 9, 15, 12);
  OfferSummary offer(String status) => OfferSummary(
    id: 'offer',
    shiftId: 'shift',
    status: status,
    sentAt: now,
    expiresAt: now.add(const Duration(days: 2)),
    startsAt: now,
    endsAt: now.add(const Duration(hours: 8)),
    estimatedPayPence: 0,
    payRatePence: 0,
    venueName: 'Venue',
    roleName: 'Role',
    staffProfileId: 'staff',
    staffName: 'Staff',
  );
  OfferDetailUiState resolve(
    String status, {
    bool loading = false,
    bool failed = false,
    String? clockable,
    DateTime? at,
  }) => OfferDetailUiState.resolve(
    offer: offer(status),
    active: null,
    history: [],
    clockableShiftId: clockable,
    loading: loading,
    failed: failed,
    now: at ?? now,
  );

  test(
    'authoritative statuses map independently from acceptance timestamps',
    () {
      for (final entry in {
        'pending': OfferDetailUiState.offer,
        'staff_accepted': OfferDetailUiState.pending,
        'manager_confirmed': OfferDetailUiState.ready,
        'expired': OfferDetailUiState.expired,
        'withdrawn': OfferDetailUiState.cancelled,
        'declined': OfferDetailUiState.declined,
        'manager_rejected': OfferDetailUiState.rejected,
        'unknown': OfferDetailUiState.error,
      }.entries) {
        expect(resolve(entry.key), entry.value);
      }
    },
  );
  test('clock flow must select this exact confirmed shift', () {
    expect(
      resolve('manager_confirmed', clockable: 'shift'),
      OfferDetailUiState.clockIn,
    );
    expect(
      resolve('manager_confirmed', clockable: 'different'),
      OfferDetailUiState.ready,
    );
    expect(
      resolve('staff_accepted', clockable: 'shift'),
      OfferDetailUiState.pending,
    );
  });
  test('loading and failure are distinct from readiness or pending', () {
    expect(
      resolve('manager_confirmed', loading: true),
      OfferDetailUiState.loading,
    );
    expect(
      resolve('manager_confirmed', failed: true),
      OfferDetailUiState.error,
    );
  });
  test('elapsed schedule alone does not claim completed attendance', () {
    expect(
      resolve('manager_confirmed', at: now.add(const Duration(days: 1))),
      OfferDetailUiState.ended,
    );
  });
}
