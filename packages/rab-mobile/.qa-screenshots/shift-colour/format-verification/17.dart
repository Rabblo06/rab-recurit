import '../../core/models/offer.dart';
import '../../core/models/attendance.dart';

enum OfferDetailUiState {
  loading,
  error,
  offer,
  pending,
  ready,
  clockIn,
  clockOut,
  completed,
  ended,
  expired,
  cancelled,
  declined,
  rejected;

  String get label => switch (this) {
    loading => 'Loading',
    error => 'Unable to refresh',
    offer => 'Offer',
    pending => 'Pending',
    ready || clockIn || clockOut => 'Confirmed',
    completed => 'Completed',
    ended => 'Ended',
    expired => 'Expired',
    cancelled => 'Cancelled',
    declined => 'Declined',
    rejected => 'Not confirmed',
  };
  static OfferDetailUiState resolve({
    required OfferSummary offer,
    required AttendanceSummary? active,
    required List<AttendanceSummary> history,
    required String? clockableShiftId,
    bool loading = false,
    bool failed = false,
    DateTime? now,
  }) {
    if (loading) return OfferDetailUiState.loading;
    if (failed) return error;
    if (active?.isOpen == true && active?.shiftId == offer.shiftId) {
      return clockOut;
    }
    if (history.any((a) => a.shiftId == offer.shiftId && a.hasEnded)) {
      return completed;
    }
    return switch (offer.status) {
      'pending' => OfferDetailUiState.offer,
      'staff_accepted' => pending,
      'manager_confirmed' =>
        (now ?? DateTime.now()).isAfter(offer.endsAt)
            ? ended
            : active == null && clockableShiftId == offer.shiftId
            ? clockIn
            : ready,
      'expired' => expired,
      'withdrawn' => cancelled,
      'declined' => declined,
      'manager_rejected' => rejected,
      _ => error,
    };
  }
}
