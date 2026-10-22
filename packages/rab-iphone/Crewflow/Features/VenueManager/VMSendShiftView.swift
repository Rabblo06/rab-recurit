import SwiftUI

/// Send Shift (Flutter `SendShiftScreen`): a staffing REQUEST
/// (`POST /shifts/request`) for the selected team — venue, role, date,
/// times, break, staff picker with availability, per-person windows/breaks.
/// A Manager still approves it. The staff count is derived from the real
/// selection, never typed.
///
/// - No note field: the server accepts `note` but silently drops it (B3),
///   so the app never offers text it would not save.
/// - No idempotency key: an uncertain result (timeout, connection lost,
///   5xx, unreadable 201) LOCKS the form — "check Sent Shifts" — and is never
///   resent automatically.
/// - 409 STAFF_AVAILABILITY_CONFLICT: nothing was created; "Submit anyway"
///   resends once with the exact dates acknowledged.
struct VMSendShiftView: View {
    let initialStaff: [DirectoryUser]
    let onSubmitted: (() -> Void)?

    @EnvironmentObject private var store: VenueManagerStore
    @Environment(\.dismiss) private var dismiss
    @State private var venueId: String?
    @State private var roleId: String?
    @State private var day = VMSendShiftView.tomorrow()
    @State private var startTime = VMSendShiftView.time(hour: 9)
    @State private var endTime = VMSendShiftView.time(hour: 17)
    @State private var breakText = ""
    @State private var draft = ShiftAssignmentDraft()
    @State private var busy = false
    @State private var uncertain = false
    @State private var completed = false
    @State private var error: String?
    @State private var showsPicker = false
    @State private var editing: StaffAssignmentDraft?
    @State private var conflict: VMSheetItem<AvailabilityConflict>?
    @State private var showsSuccess = false
    @State private var started = false

    init(initialStaff: [DirectoryUser], onSubmitted: (() -> Void)? = nil) {
        self.initialStaff = initialStaff
        self.onSubmitted = onSubmitted
    }

    static func tomorrow() -> Date {
        let calendar = VMDate.calendar
        return calendar.date(byAdding: .day, value: 1, to: calendar.startOfDay(for: Date())) ?? Date()
    }

    static func time(hour: Int) -> Date {
        let calendar = VMDate.calendar
        return calendar.date(bySettingHour: hour, minute: 0, second: 0, of: Date()) ?? Date()
    }

    private var window: (startsAt: Date, endsAt: Date) { SendShiftComposer.compose(day: day, start: startTime, end: endTime) }
    private var locked: Bool { busy || completed || uncertain }
    private var inheritedBreak: Int { SendShiftComposer.draftBreak(text: breakText, venue: store.venue(venueId)) }
    private var invalidAssignments: Bool { draft.assignments.contains { !$0.isValid(defaultBreak: inheritedBreak) } }
    private var canSubmit: Bool {
        !busy && venueId != nil && roleId != nil && !draft.assignments.isEmpty && !invalidAssignments && !completed && !uncertain
            && !store.loading && store.error == nil && store.allows(.staffingRequestCreate)
    }

    var body: some View {
        VMPage(title: "Send Shift") {
            if store.loading && store.updatedAt == nil {
                VMInlineLoading()
            } else if let storeError = store.error {
                MessageCard(title: "Could not refresh staffing access", message: storeError, kind: .error, actionTitle: "Retry") {
                    Task { await store.refresh() }
                }
                .padding(ScheduleTokens.homeInset)
            } else {
                form
            }
        }
        .safeAreaInset(edge: .bottom) {
            BottomAction {
                PrimaryButton("Send Shift Offer", systemImage: "paperplane", isBusy: busy, background: VMColor.navy) {
                    Task { await send() }
                }
                .disabled(!canSubmit)
                .accessibilityIdentifier("vm.send.submit")
            }
            .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        }
        .interactiveDismissDisabled(busy)
        .onAppear {
            guard !started else { return }
            started = true
            draft.select(initialStaff, start: window.startsAt, end: window.endsAt)
        }
        .onChange(of: day) { _ in parentChanged() }
        .onChange(of: startTime) { _ in parentChanged() }
        .onChange(of: endTime) { _ in parentChanged() }
        .sheet(isPresented: $showsPicker) {
            NavigationStack {
                VMUsersScreen(mode: .picker(initial: draft.selected, startAt: window.startsAt, endAt: window.endsAt,
                                            excludeShiftId: nil, onDone: { picked in
                    draft.select(picked, start: window.startsAt, end: window.endsAt)
                }))
            }
            .environmentObject(store)
        }
        .sheet(item: $editing) { assignment in
            VMAssignmentEditor(assignment: assignment, requestStart: window.startsAt, inheritedBreak: inheritedBreak) { saved in
                draft.update(saved)
                editing = nil
            } cancel: {
                editing = nil
            }
            .presentationDetents([.large])
        }
        .sheet(item: $conflict) { item in
            VMAvailabilityConflictSheet(conflict: item.value) { proceed in
                conflict = nil
                if proceed { Task { await send(acknowledgements: item.value.acknowledgements) } }
            }
            .presentationDetents([.medium, .large])
        }
        .sheet(isPresented: $showsSuccess, onDismiss: finish) {
            VMSheet {
                Image(systemName: "checkmark")
                    .font(.system(size: 22, weight: .bold))
                    .foregroundStyle(RGBA(argb: 0xFF159A64).color)
                    .frame(width: 48, height: 48)
                    .background(Circle().fill(RGBA(argb: 0xFFE6F5ED).color))
                    .frame(maxWidth: .infinity)
                    .accessibilityHidden(true)
                Text("Shift submitted successfully").scheduleType(ScheduleType.heading.colored(VMColor.navy))
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 16)
                Text("Your staffing request has been sent for manager approval.\nYou can track its status from your shifts.")
                    .scheduleType(ScheduleType.body.colored(ScheduleTokens.successText))
                    .multilineTextAlignment(.center).frame(maxWidth: .infinity).padding(.top, 8)
                PrimaryButton("Done", background: VMColor.navy) { showsSuccess = false }.padding(.top, 20)
            }
            .presentationDetents([.medium])
            .interactiveDismissDisabled()
        }
        .accessibilityIdentifier("vm.sendShift")
    }

    private var form: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Text("Create and send a shift offer to staff").scheduleType(ScheduleType.caption)
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 10) { venueField; roleField }
                    VStack(spacing: 14) { venueField; roleField }
                }
                VMField(label: "Date") {
                    DatePicker("Date", selection: $day, displayedComponents: .date)
                        .labelsHidden()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .vmInputBox()
                        .disabled(locked)
                }
                HStack(alignment: .top, spacing: 10) {
                    VMField(label: "Start time") {
                        DatePicker("Start time", selection: $startTime, displayedComponents: .hourAndMinute)
                            .labelsHidden().frame(maxWidth: .infinity, alignment: .leading).vmInputBox().disabled(locked)
                    }
                    VMField(label: window.endsAt.timeIntervalSince(window.startsAt) > 0 && !VMDate.sameDay(window.startsAt, window.endsAt) ? "End time (+1 day)" : "End time") {
                        DatePicker("End time", selection: $endTime, displayedComponents: .hourAndMinute)
                            .labelsHidden().frame(maxWidth: .infinity, alignment: .leading).vmInputBox().disabled(locked)
                    }
                }
                VMField(label: "Break (minutes)", error: SendShiftComposer.parseBreak(breakText) == .invalid ? "Enter zero or more minutes" : nil) {
                    TextField("Venue default", text: $breakText)
                        .keyboardType(.numberPad)
                        .vmInputBox()
                        .disabled(locked)
                        .accessibilityIdentifier("vm.send.break")
                }
                VMField(label: "Number of staff required") {
                    HStack {
                        Image(systemName: "person.3").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
                        Text("\(draft.assignments.count) selected").scheduleType(ScheduleType.body).frame(maxWidth: .infinity, alignment: .leading)
                        Button("Select staff") { showsPicker = true }
                            .scheduleType(ScheduleType.badge.colored(.white))
                            .padding(.horizontal, 12)
                            .frame(minHeight: 44)
                            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(VMColor.navy))
                            .disabled(locked)
                            .accessibilityIdentifier("vm.send.selectStaff")
                    }
                    .vmInputBox()
                }
                // Group: keeps this VStack within ViewBuilder's 10-child limit
                // (the variadic builder needs iOS 17). Layout is unchanged.
                Group {
                    Divider().padding(.vertical, 4)
                    Text("Selected staff").scheduleType(ScheduleType.caption)
                    if draft.assignments.isEmpty {
                        Text("Select staff to build your team.").scheduleType(ScheduleType.body).padding(.vertical, 12)
                    }
                    ForEach(draft.assignments) { assignment in assignmentCard(assignment) }
                    if let error {
                        MessageCard(title: error, kind: .error).padding(.top, 8)
                    }
                }
            }
            .padding(EdgeInsets(top: 8, leading: 18, bottom: 24, trailing: 18))
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
            .environment(\.timeZone, CrewflowDateFormat.displayTimeZone)
        }
        .scrollDismissesKeyboard(.interactively)
    }

    private var venueField: some View {
        VMField(label: "Venue") {
            Menu {
                ForEach(store.venues) { venue in Button(venue.name) { venueId = venue.id } }
            } label: {
                menuLabel(store.venue(venueId)?.name ?? "Select venue", icon: "storefront", placeholder: venueId == nil)
            }
            .disabled(locked)
            .accessibilityIdentifier("vm.send.venue")
        }
    }

    private var roleField: some View {
        VMField(label: "Role") {
            Menu {
                ForEach(store.jobRoles) { role in Button(role.name) { roleId = role.id } }
            } label: {
                menuLabel(store.jobRoles.first { $0.id == roleId }?.name ?? "Select role", icon: "person.text.rectangle", placeholder: roleId == nil)
            }
            .disabled(locked)
            .accessibilityIdentifier("vm.send.role")
        }
    }

    private func menuLabel(_ text: String, icon: String, placeholder: Bool) -> some View {
        HStack(spacing: 8) {
            Image(systemName: icon).foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
            Text(text).scheduleType(placeholder ? ScheduleType.secondary : ScheduleType.body).lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.down").font(.system(size: 12, weight: .semibold)).foregroundStyle(ScheduleTokens.muted)
                .accessibilityHidden(true)
        }
        .vmInputBox()
    }

    private func assignmentCard(_ assignment: StaffAssignmentDraft) -> some View {
        let valid = assignment.isValid(defaultBreak: inheritedBreak)
        return ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) { identity(assignment, valid: valid); editButton(assignment) }
            VStack(alignment: .trailing, spacing: 6) { identity(assignment, valid: valid); editButton(assignment) }
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 20, style: .continuous).stroke(valid ? .clear : ScheduleTokens.errorText, lineWidth: 1))
    }

    private func identity(_ assignment: StaffAssignmentDraft, valid: Bool) -> some View {
        HStack(spacing: 10) {
            InitialsAvatar(name: assignment.staff.name, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                Text(assignment.staff.name).scheduleType(ScheduleType.bodyStrong)
                Text(valid ? (VMDirectory.employmentLabel(assignment.staff.status) ?? assignment.staff.status) : "Edit time or break duration")
                    .scheduleType(ScheduleType.caption.colored(valid ? ScheduleTokens.muted : ScheduleTokens.errorText))
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func editButton(_ assignment: StaffAssignmentDraft) -> some View {
        Button { editing = assignment } label: {
            HStack(spacing: 4) {
                Text("\(timeLabel(assignment.startsAt)) - \(timeLabel(assignment.endsAt))").scheduleType(ScheduleType.caption.colored(.white))
                Image(systemName: "pencil").font(.system(size: 13)).accessibilityHidden(true)
            }
            .foregroundStyle(.white)
            .padding(.horizontal, 10)
            .frame(minHeight: 44)
            .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(VMColor.navy))
        }
        .buttonStyle(PressableButtonStyle())
        .disabled(locked)
        .accessibilityLabel("Edit assignment time for \(assignment.staff.name)")
    }

    private func timeLabel(_ date: Date) -> String {
        VMDate.hm(date) + (VMDate.sameDay(date, window.startsAt) ? "" : " (+1 day)")
    }

    private func parentChanged() {
        draft.parentChanged(start: window.startsAt, end: window.endsAt)
    }

    private func finish() {
        onSubmitted?()
        dismiss()
    }

    @MainActor
    private func send(acknowledgements: [SubmitShiftRequestBody.Acknowledgement]? = nil) async {
        guard !busy, !completed, !uncertain else { return }
        guard store.allows(.staffingRequestCreate) else {
            error = "Your account does not have permission to submit shift requests."
            return
        }
        let built = SendShiftComposer.body(venueId: venueId, jobRoleId: roleId, day: day, start: startTime, end: endTime,
                                           breakText: breakText, draft: draft, venue: store.venue(venueId),
                                           acknowledgements: acknowledgements)
        let body: SubmitShiftRequestBody
        switch built {
        case .failure(let problem):
            error = problem.message
            return
        case .success(let value):
            body = value
        }
        busy = true
        error = nil
        do {
            _ = try await store.repository.submitShiftRequest(body)
            completed = true
            await store.refresh(silent: true)
            busy = false
            showsSuccess = true
        } catch {
            busy = false
            if let found = AvailabilityConflict.from(error) {
                conflict = VMSheetItem(value: found)
                return
            }
            let api = error as? APIError
            var unknownResult = api?.isUncertainOutcome == true
            if case .decoding? = api { unknownResult = true }
            if unknownResult || api == nil {
                // No idempotency key: never resend a create whose result is unknown.
                uncertain = true
                self.error = "The send result could not be confirmed. Check Sent Shifts before creating another shift."
                await store.refresh(silent: true)
            } else if api != .cancelled, api != .sessionChanged {
                self.error = vmMessage(error, fallback: "Unable to send offers. Please try again.")
            }
        }
    }
}

/// One person's window + break (Flutter `editAssignment` sheet).
private struct VMAssignmentEditor: View {
    let assignment: StaffAssignmentDraft
    let requestStart: Date
    let inheritedBreak: Int
    let save: (StaffAssignmentDraft) -> Void
    let cancel: () -> Void

    @State private var from: Date
    @State private var to: Date
    @State private var breakText: String

    init(assignment: StaffAssignmentDraft, requestStart: Date, inheritedBreak: Int,
         save: @escaping (StaffAssignmentDraft) -> Void, cancel: @escaping () -> Void) {
        self.assignment = assignment
        self.requestStart = requestStart
        self.inheritedBreak = inheritedBreak
        self.save = save
        self.cancel = cancel
        _from = State(initialValue: assignment.startsAt)
        _to = State(initialValue: assignment.endsAt)
        _breakText = State(initialValue: assignment.breakMinutes.map(String.init) ?? "")
    }

    /// The picked times on the request's day; an end before the start rolls
    /// to the next day.
    private var candidate: StaffAssignmentDraft {
        let window = SendShiftComposer.compose(day: requestStart, start: from, end: to)
        var next = assignment
        next.customised = assignment.customised || window.startsAt != assignment.startsAt || window.endsAt != assignment.endsAt
        next.startsAt = window.startsAt
        next.endsAt = window.endsAt
        let trimmed = breakText.trimmingCharacters(in: .whitespaces)
        next.breakMinutes = trimmed.isEmpty ? nil : (Int(trimmed) ?? -1)
        return next
    }

    var body: some View {
        let valid = candidate.isValid(defaultBreak: inheritedBreak)
        VMSheet {
            Text(assignment.staff.name).scheduleType(ScheduleType.heading)
            Text("Shift time").scheduleType(ScheduleType.body).padding(.top, 16)
            HStack(spacing: 10) {
                VMField(label: "Start time") {
                    DatePicker("Start time", selection: $from, displayedComponents: .hourAndMinute)
                        .labelsHidden().frame(maxWidth: .infinity, alignment: .leading).vmInputBox()
                }
                VMField(label: "End time") {
                    DatePicker("End time", selection: $to, displayedComponents: .hourAndMinute)
                        .labelsHidden().frame(maxWidth: .infinity, alignment: .leading).vmInputBox()
                }
            }
            .padding(.top, 12)
            .environment(\.timeZone, CrewflowDateFormat.displayTimeZone)
            VMField(label: "Break (minutes) (Optional)") {
                TextField("Inherit \(inheritedBreak) minutes", text: $breakText).keyboardType(.numberPad).vmInputBox()
            }
            .padding(.top, 16)
            if !valid {
                Text("End must follow start; break must be a whole number shorter than the assignment.")
                    .scheduleType(ScheduleType.caption.colored(ScheduleTokens.errorText)).padding(.vertical, 12)
            }
            HStack(spacing: 12) {
                PrimaryButton("Cancel", variant: .light, action: cancel)
                PrimaryButton("Save") { save(candidate) }.disabled(!valid)
            }
            .padding(.top, 16)
        }
    }
}

/// Staff availability warning: true only on an explicit "Submit anyway".
private struct VMAvailabilityConflictSheet: View {
    let conflict: AvailabilityConflict
    let decide: (Bool) -> Void

    var body: some View {
        let single = conflict.totalRecipients == 1 && conflict.entries.count == 1 ? conflict.entries.first : nil
        VMSheet {
            Text("Staff availability warning").scheduleType(ScheduleType.heading.colored(VMColor.navy))
            VStack(alignment: .leading, spacing: 8) {
                if let single {
                    Text("\(single.staffName) has marked themselves as unavailable on \(VMText.formatWeekdayList(single.weekdays)).")
                        .scheduleType(ScheduleType.body)
                    Text("Available days: \(VMText.formatWeekdayList(single.availableDays)).").scheduleType(ScheduleType.body)
                } else {
                    Text("\(conflict.entries.count) of \(conflict.totalRecipients) selected Staff have availability conflicts.")
                        .scheduleType(ScheduleType.bodyStrong.colored(VMColor.navy))
                    ForEach(conflict.entries, id: \.staffProfileId) { entry in
                        Text("\(entry.staffName) — unavailable on \(VMText.formatWeekdayList(entry.weekdays)) (\(entry.dates.joined(separator: ", "))). Available days: \(VMText.formatWeekdayList(entry.availableDays)).")
                            .scheduleType(ScheduleType.body)
                    }
                    if conflict.unknownCount > 0 {
                        Text("\(conflict.unknownCount) selected \(VMText.plural(conflict.unknownCount, "person has", "people have")) not provided availability — that is not treated as unavailable.")
                            .scheduleType(ScheduleType.body).italic()
                    }
                }
                Text("You can cancel or choose to submit the request anyway. A manager still has to approve it.")
                    .scheduleType(ScheduleType.body)
            }
            .padding(.top, 12)
            HStack(spacing: 12) {
                PrimaryButton("Cancel", variant: .light) { decide(false) }
                PrimaryButton("Submit anyway", background: VMColor.navy) { decide(true) }
                    .accessibilityIdentifier("vm.send.submitAnyway")
            }
            .padding(.top, 20)
        }
        .accessibilityIdentifier("vm.send.conflict")
    }
}
