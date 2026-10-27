# Product truth for the introduction film

This is the evidence base for every claim in `script.json`.

- **Method:** a read-only audit of the local code at `f5187172` (2026-10-20). Paths are relative to `packages/`.
- **Status key:** A = available, P = partial, N = not available or planned.
- **Limits:** these findings come from reading code. They are not runtime proof that emails, push or auto clock-out work in a live deployment.

## Feature-to-evidence matrix

| Feature | Current implementation | Source | Screen | Status | Script wording used |
| --- | --- | --- | --- | --- | --- |
| Roles and apps | Managers and CEOs use the web console. Venue managers and staff use the mobile app, each in their own mode. | `rab-server/src/modules/manager/services/manager.service.ts:48-156` | Web Users; mobile Staff and VM modes | A | "Managers run their agency from the web console… Venue managers use the Crewflow app…" |
| Workspace | Each manager works in a private workspace, isolated by row-level security. There is no workspace switcher. | `rab-docs/getting-started/organisations-and-workspaces.mdx`; `rab-server/src/engine` | Web sidebar | A | "Each manager has a private workspace" |
| Assigned staff | The manager assigns staff to a VM. The VM's directory lists only those staff, and requests naming anyone else are refused. | `rab-front/src/features/users/VenueManagerTeamSection.tsx`; `rab-server/src/modules/staff/services/venue-team-scope.ts` | Web VM panel "Assigned staff"; mobile Select staff | A | "the manager decides which staff they can work with… Riley sees that team, and no one else" |
| VM request | Fields: venue, role, date, time, break, staff. The required count equals the number of people selected. The request is created as `pending_manager_approval`. | `rab-mobile/lib/features/venue_manager/send_shift_screen.dart`; `rab-server/src/modules/scheduling/services/scheduling.service.ts:597-700` | Mobile Send Shift | A | "Riley chooses the venue, the role, the time and the break, then picks four people… The request goes to the manager for approval. Nothing reaches the staff yet." |
| Availability | A weekday-availability conflict is an overridable warning ("Submit anyway"); an overlapping confirmed booking is a hard block. | `scheduling.service.ts:577-625`; `rab-mobile/lib/features/venue_manager/availability_conflict.dart` | Mobile "Staff availability warning" | A | "Crewflow warns Riley before anything is sent" |
| Approval | Shift Approval drawer: Approve creates one offer per person. The manager can add or remove people first. | `rab-front/src/features/scheduling/ShiftApprovalDrawer.tsx`; `rab-server/src/modules/offer/services/offer.service.ts:653-755` | Web Venue Offers → Shift Approval | A | "the manager checks the request, can change who's on it, and approves" |
| Offer | Each person receives an offer showing venue, time and estimated pay. | `offer.service.ts:313-429` | Mobile offer card and details | A | "their own offer, with the venue, the time, and their estimated pay" |
| Accept: approved request | When `requestedBy != null`, Accept confirms in the same transaction. | `offer.service.ts:877-885,972-982` | Mobile "CONFIRMED" | A | "accepting books her straight away" |
| Accept: manager-created shift | Accept moves the offer to `staff_accepted`. The manager then confirms, or it auto-confirms after a configurable timeout. | `offer.service.ts:948-970`; `rab-worker/src/queues/rab-offers/offer-expiry.job.ts` | Web Offers "Awaiting Confirmation" | A | "accepting reserves the place until the manager confirms it" |
| Staffing board | 12 lanes covering each person from offer to clock-out. | `rab-front/src/features/scheduling/VenueOfferPipeline.tsx` | Web Venue Offers board | A | "follow every person on the live staffing board" |
| Shift notes | The staff clock screen shows the shift's notes (`shiftNotes`). | `rab-mobile/lib/features/home/schedule_clock_screen.dart:993-999` | Mobile clock/shift screen | A (not for VM requests: `SchedulingService.submitRequest` stores no notes) | not used — the story shift is a VM request |
| Staff hours | Staff History lists their own attendance with worked time and earnings. | `rab-mobile/lib/features/history/history_screen.dart` | Mobile History | A | "check their hours" |
| Clock window | Opens a configurable number of minutes before the start (default 15). Server time is authoritative. | `rab-server/src/modules/attendance/services/attendance.service.ts:149-159` | Mobile clock screen | A | "Clock-in opens shortly before the start" |
| QR | One signed token per shift, validated on the server at clock-in and clock-out. It does not rotate. | `rab-server/src/modules/attendance/services/qr-token.service.ts`, `attendance-qr.service.ts` | Mobile Scan venue QR | A | "scans the shift's QR code, and Crewflow checks it on its server" |
| Geofence | Checked only when the venue enforces it, and then it blocks. | `attendance.service.ts:172-193` | Mobile location sheet | A | "Where a venue requires it, she also has to be on site" |
| Live timer | `serverNow − clockInAt` (trusted server time). | `rab-mobile/lib/features/home/attendance_provider.dart:46-81` | Mobile LIVE SHIFT | A | "timed by Crewflow's own clock, not her phone's" |
| Missing clock-out | Flagged 30 minutes after the end. There is no auto clock-out; hours stay empty until corrected. | `rab-worker/src/queues/rab-shifts/shift-monitor.job.ts`; `rab-server/src/modules/attendance/services/missing-clock-out-policy.ts` | VM report "Missing" | A | "Crewflow flags it, rather than guessing her hours" |
| Correction | Requires a reason of at least 10 characters. It recalculates worked time, sets `under_review` and clears any earlier review. VM app only. | `attendance.service.ts:607-742` | Mobile Review staff report → Save correction | A | "enters the correct time, gives a reason, and saves the correction" |
| Mark reviewed | A separate action per person. It is refused while someone is still clocked in or has no clock-out. | `rab-server/src/modules/attendance/services/shift-report.service.ts:261-297` | Mobile "Mark reviewed" | A | "Saving a correction isn't the same as approving it… marks each person's hours as reviewed" |
| Staff rating | A separate "Staff review" tab. Optional; not part of the finalise gate. | `rab-server/src/modules/attendance/services/shift-review.service.ts` | Mobile Staff review tab | A | "a separate, optional step" |
| Finalise gate | Everyone must be clocked out (or a no-show) and every seat reviewed. | `rab-server/src/modules/attendance/services/report-readiness.ts`, `report-actions.ts` | Mobile footer | A | "Only when everyone is clocked out and reviewed…" |
| Sign-off | A break-confirmation tick plus a typed full name ("It is not a handwritten signature"). Locks corrections and reviews. | `rab-mobile/lib/features/venue_manager/sign_off_sheet.dart` | Mobile "Sign off the timesheet" | A | "confirms the break details, types their name to sign off… That locks the hours." |
| PDF and delivery | The worker renders the Adolphus PDF. States: Generating PDF → Queued for delivery → Sent. Email goes to the venue's VMs, and only if email is configured. | `rab-worker/src/queues/rab-reports/final-timesheet.job.ts`; `rab-server/src/modules/attendance/templates/final-timesheet.html.ts` | Mobile lifecycle labels | A | "creates the final timesheet as a PDF, queues it for delivery, and shows when it has been sent" |
| Web timesheets | The Timesheet Report drawer shows the Original and the Venue Signed timesheet. | `VenueOfferPipeline.tsx:554-610` | Web drawer | A | "both the original and the signed timesheet on the web" |
| History | A display bucket; nothing is deleted. | `rab-server/src/modules/attendance/services/report-lifecycle.ts` | Mobile History | A | "finished shifts move to History" |
| Payroll | A list of attendance rows with hours and earned pay. No pay runs and no money movement. The tabs and the Status filter are defective (400). | `rab-front/src/features/payroll/Payroll.tsx` | Web Payroll (All records only) | P | "appear in Payroll, with the pay they add up to… Crewflow doesn't move any money" |
| Staff reviews | VM ratings appear read-only on the staff record for the owning manager. | `rab-front/src/features/users/StaffReviewsTab.tsx` | Web staff panel | A | "Ratings… build up on each staff member's record" |
| Dashboard and calendar | Offer strip, totals, hours, venues, shift readiness, week view; a month calendar. | `rab-front/src/features/dashboard/Dashboard.tsx`; `rab-front/src/features/scheduling/Calendar.tsx` | Web | A | "the calendar and dashboard show the week ahead, the hours worked, and how ready your next shift is" |
| Server checks | Permissions are resolved server-side on each request, scoped to the tenant workspace. | `CLAUDE.md`; `rab-server/src/engine` | — | A | "checks who you are, and which workspace you belong to, on every request" |
| Background jobs | The worker handles expiries, reminders, the no-show and missing clock-out monitor, PDFs, and email, push and realtime outboxes. | `rab-worker/src/main.ts` | — | A | "Background jobs look after reminders, expiries and documents" |

## Claims the film must not make

- **Acceptance:** that accepting always needs manager confirmation. Approved VM requests confirm on Accept.
- **Requests:** that a VM request goes straight to staff.
- **Pay:**
  - that Crewflow pays staff, runs pay runs, produces payslips or handles tax;
  - that Payroll's tabs work.
- **Attendance:**
  - that missing clock-outs auto-close;
  - that the QR code rotates;
  - that location is always checked;
  - that breaks are started and stopped in the app.
- **Sign-off and delivery:**
  - that the PDF is emailed to the manager;
  - that the sign-off is a handwritten signature;
  - that managers correct or finalise on the web;
  - that a rating is required.
- **Features that don't exist yet:** push notifications, realtime updates, iOS, AI, CSV export, week view, drag-and-drop.
- **History:** that History deletes or archives anything.
- **Timings:** hard numbers (15 min, 60 min, 48 h, and so on), because these are configurable.

## Discrepancies found (docs and UI versus code)

These are reported in the final report. The film follows the code.

- `getting-started/workflow-overview.mdx`:
  - says the final PDF goes to the manager (it goes to VMs);
  - says staff "wait for manager confirmation" (not true for approved requests);
  - says the rate is locked when the offer is sent (it is re-snapshotted at confirmation).
- `how-crewflow-works.mdx:48`: the same rate wording.
- `attendance/clock-in-and-out.mdx`: auto clock-out on leaving applies to any venue with coordinates, not only venues that enforce the geofence.
- VM app copy: "Send Shift Offer" actually submits a request for approval.
- Shift Approval drawer: per-person times show a literal "?" (`ShiftApprovalDrawer.tsx:267`). Avoid framing it in close-up.
- In-app help "Finalise a timesheet" describes a web flow that does not exist.
