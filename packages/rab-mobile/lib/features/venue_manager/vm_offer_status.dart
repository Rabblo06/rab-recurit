import '../../core/models/offer.dart';

/// The Venue Manager's reading of one offer: the server's offer status plus
/// the manager-confirmation projection (`closedReason`,
/// `awaitingManagerConfirmation`). Display only, never an authorization rule.
/// A withdrawn, unconfirmed acceptance never reads as accepted or confirmed;
/// a missing projection (older server) keeps the plain status label.
///
/// [statusLabel] maps a bare status (each screen keeps its own wording).
String vmOfferLabel(
  OfferSummary offer,
  String Function(String status) statusLabel,
) {
  if (offer.withdrawnAtDeadline) return ConfirmationDeadlineCopy.managerState;
  if (offer.effectiveClosedReason == OfferClosedReason.shiftCancelled) {
    return 'Shift cancelled';
  }
  return statusLabel(offer.status);
}

/// "Manager confirmation due by HH:mm" for an acceptance still awaiting a
/// manager, from the server's `approvalDeadlineAt`; null otherwise.
String? vmConfirmationDue(OfferSummary offer) {
  final deadline = offer.approvalDeadlineAt;
  if (!offer.isAwaitingManagerConfirmation || deadline == null) return null;
  return 'Manager confirmation due by '
      '${approvalDeadlineTime(deadline, offer.startsAt)}';
}
