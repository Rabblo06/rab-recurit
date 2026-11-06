// The user profile the journeys replay, with the source of every number. Labels as in the harness README:
//   CODE     read from the client code on main (file:line), exact
//   SEED     the harness seed's shape (seed/seed.js: 1 CEO, 2 managers, 3 venue managers, 44 staff per organisation;
//            10 shifts/day, 3-5 seats each; 40 % confirmed, 20 % offered, 10 % accepted, 10 % declined, 20 % unfilled)
//   ASSUMED  a human-behaviour number with no measured source (there are no production request logs: the only deployed
//            environment is a temporary test deploy, and the staging soak and the shadow run drive synthetic traffic
//            only). Each is a busy-hour assumption, written down so it can be challenged, and the same in every arm.
// The realistic-load-test method fixes per-user rate from logs; without logs it says "use cautious assumptions and label
// them" (references/profiling.md), which is what this file does.
export const PROFILE = {
  // Per active organisation at a busy hour (ASSUMED): the Initial Manager has the console open, one Venue Manager and
  // three staff have the app in the foreground on and off. K6P_ORGS organisations are active; the others only cost the
  // Worker's sweeps (all 200 are seeded, as in D-Q6).
  perOrg: { im: 1, vm: 1, staff: 3 },
  // CODE poll intervals (±20 % jitter, serial: rab-front shared/lib/polling.ts, rab-mobile core/polling/poll_scheduler.dart).
  poll: {
    staffReconcileS: 30, // rab-mobile navigation/app_shell.dart PollScheduler 30 s: offers/mine scope=current + attendance/me/active
    bellS: 60, // notifications_provider.dart pollInterval 60 s; rab-front NotificationBell.tsx:12 UNREAD_POLL_MS 60_000
    vmSentS: 30, // venue_manager/sent_shifts_screen.dart:66 VenueSentShiftsScreen.pollInterval 30 s: /shifts/sent page 1, limit 50
    webPipelineS: 15, // rab-front scheduling/VenueOfferPipeline.tsx:258 PIPELINE_POLL_MS 15_000
    webVenueOffersS: 30, // rab-front scheduling/VenueOffers.tsx:33 VENUE_OFFERS_POLL_MS 30_000
  },
  // No-autoconfirm rule (owner 2026-11-06; system spec 02-business-flow.spec.ts:66): a standard offer is accepted and
  // confirmed only before start - 30 min. The journeys act only on shifts starting more than this many minutes ahead.
  deadlineMarginMin: 60,
  staff: {
    sessionS: [90, 240], // ASSUMED: one look at the app (offers, today's shift), 1.5-4 min in the foreground
    awayS: [30, 120], // ASSUMED: phone away between looks (no requests: polls run only in the foreground, CODE)
    acceptP: 0.5, // ASSUMED: half the looks answer a pending offer (SEED: ~1.8 pending offers per staff member)
    decideS: [5, 20], // ASSUMED: reading the offer card before Accept
    historyP: 0.3, // ASSUMED: opens attendance history
    payslipsP: 0.15, // ASSUMED: opens payslips/statements (READ)
  },
  vm: {
    sessionS: [90, 240], // ASSUMED
    awayS: [60, 180], // ASSUMED
    requestP: 0.4, // ASSUMED: submits a staff request (one or two of the team) in 40 % of sessions
    formS: [20, 60], // ASSUMED: filling the request form
    sentDetailP: 0.5, // ASSUMED: opens one sent shift
    attendanceP: 0.3, // ASSUMED: opens the attendance report history and one shift's report
  },
  im: {
    visits: [3, 5], // ASSUMED: pages visited per console session
    dwellS: [20, 90], // ASSUMED: time on a page (its polls keep running, CODE)
    awayS: [60, 180], // ASSUMED: tab hidden (polls paused, CODE: refetchIntervalInBackground false)
    reviewS: [5, 20], // ASSUMED: reading a request or an accepted offer before approving/confirming
    sendOfferP: 0.4, // ASSUMED: sends one offer from a shift's pipeline
    // ASSUMED page mix, weighted towards the two decisions the no-autoconfirm rule makes manual (approve, confirm).
    pageWeights: { approvals: 25, confirmations: 25, venueOffers: 15, pipeline: 15, calendar: 10, payroll: 10 },
  },
};
