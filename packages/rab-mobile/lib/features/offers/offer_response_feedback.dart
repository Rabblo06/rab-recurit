import 'package:flutter/widgets.dart';

import '../../core/widgets/schedule_feedback.dart';
import '../../core/widgets/schedule_toast.dart';
import 'offers_provider.dart';

/// Accept / Decline with a temporary result message. The response itself is
/// unchanged ([OffersProvider.respond]); success is only announced after the
/// server accepted it, and a failure shows the provider's normalised message.
/// The overlay is captured first because a declined card leaves the list
/// before the result arrives.
Future<void> respondToOffer(
  BuildContext context,
  OffersProvider offers,
  String offerId,
  String action,
) async {
  final overlay = ScheduleToast.overlayOf(context);
  await offers.respond(offerId, action);
  if (overlay == null) return;
  final failure = offers.errorOfferId == offerId ? offers.errorMessage : null;
  if (failure != null) {
    ScheduleToast.showOn(overlay, failure, kind: ScheduleMessageKind.error);
    return;
  }
  ScheduleToast.showOn(
    overlay,
    action == 'accept' ? 'Offer accepted.' : 'Offer declined.',
    kind: ScheduleMessageKind.success,
  );
}
