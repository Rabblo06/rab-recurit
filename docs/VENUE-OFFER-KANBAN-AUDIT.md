# Venue Offers pipeline audit ? 2026-09-28

Current local source is authoritative; extensive unrelated uncommitted work is preserved.

- VenueOffers routes every row to ShiftApprovalDrawer, including approved rows. Replace only post-approval routing with a dedicated page; retain pending review and declined read-only details.
- OfferService owns sending, staff response, confirmation, expiry and withdrawal. Pending withdrawal exists; confirmed bookings require assignment CANCELLED (offer MANAGER_CONFIRMED is terminal). Preserve that offer history, release the seat exactly once and use existing mobile cancellation projection.
- Phase 3 late-clock job checks confirmed assignment, active shift, grace threshold and no attendance. Extract its pure predicate for reuse; use database time in pipeline projection. No new late state.
- Notification.readAt on offer_sent is a persisted acknowledgement. WAITING means notification read with offer still pending; it does not claim delivery or that offer details were viewed. Unread pending offers remain OFFERED. No timers or new statuses.
- UserNoteService.add already accepts the caller transaction; cancellation reason can reuse it atomically. Staff drawer opens through open-user-detail; add an optional Notes-tab hint, not another profile viewer.
- ReplacementRequestService already orchestrates automatic replacement proposals/approval with sendOneWithManager. Manual board selection will reuse StaffSelectionPage, selectable-staff query, canonical availability and OfferService sending. Existing requests for the vacancy must be reconciled, never silently auto-send another candidate.
- ShiftReport has preShiftFileId (PRE-SHIFT ROSTER, not unsigned final timesheet), finalFileId, finalisedBy and finalisedAt. Existing mobile performs PATCH finalise; no handwritten signature input/storage exists anywhere in its local flow. Finalisation is the recorded sign-off and must not be presented as a captured handwritten signature.
- final-timesheet.job.ts is the only final PDF renderer/delivery path, using renderFinalTimesheetHtml and FileService immutable storage. Extend this worker/model minimally with originalFileId for an unsigned final-timesheet snapshot. Keep finalFileId for the finalised version. Do not relabel the roster as the original timesheet.
- ReportFilePolicy delegates to ShiftReportService.canReadShift. Reuse both for original/final files. Refactor existing report staff reads into a batch to remove its existing per-assignment queries; add opaque avatar IDs and finaliser name.
- Existing report finalise rejects open attendance but currently permits confirmed assignments with no attendance. Board readiness must fail closed for those (NO_SHOW is a resolved non-working outcome). Reuse one readiness predicate in existing report service/worker.
- Existing clockIn reads assignment without a cancellation lock. Individual cancellation requires shared shift/assignment serialization and a fresh status check; add minimal locking integration, preserving attendance calculations.
- Existing listVenueOffers is workspace-wide even after approval. Tighten post-approval listing to private ownership while preserving the pending review exception.
- React Query is available; use bounded polling/invalidation, no new websocket infrastructure. No new Kanban database statuses, counters, notes or report engine.

Verification planned: projection unit tests; real PostgreSQL/RLS cancellation, cutoff, duplicate/race, replacement and report tests; specified report/attendance/storage regressions; frontend tests, typechecks/build and real browser visual/polling checks. Migration required for original_file_id only. No production deployment implied.
