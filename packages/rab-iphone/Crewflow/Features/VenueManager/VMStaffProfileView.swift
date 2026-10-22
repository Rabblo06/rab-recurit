import SwiftUI

/// Venue Manager view of one assigned staff member (Flutter
/// `VenueStaffProfileScreen`): work profile, skills, available days and the
/// favourite / emergency tags. No contact details, pay, private notes,
/// email or aggregated reviews (none exist in this projection). 404 = no
/// longer assigned: the profile is replaced by that state.
struct VMStaffProfileView: View {
    let user: DirectoryUser
    var selectionContext = false
    var onChanged: ((DirectoryUser) -> Void)?
    var onGone: (() -> Void)?
    var onSelect: (() -> Void)?

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss
    @State private var profile: VenueStaffProfile?
    @State private var current: DirectoryUser?
    @State private var error: Error?
    @State private var busy = false
    @State private var goneReported = false
    @State private var sendStaff: [DirectoryUser]?

    private var shown: DirectoryUser { current ?? user }
    private var favourite: Bool { profile?.isFavourite ?? shown.isFavourite }
    private var emergency: Bool { profile?.isEmergency ?? shown.isEmergency }
    private var gone: Bool { error.map(VMDirectory.isNotAssigned) ?? false }
    private var canSend: Bool { store.allows(.staffingRequestCreate) }

    var body: some View {
        VStack(spacing: 0) {
            NavHeader("Staff Profile", centerTitle: false, backgroundColor: .white) {
                HStack(spacing: 0) {
                    Button { Task { await toggle(favourite: true) } } label: {
                        Image(systemName: favourite ? "heart.fill" : "heart")
                            .font(.system(size: 19, weight: .semibold))
                            .foregroundStyle(favourite ? VMColor.favourite : VMColor.navy)
                            .frame(width: 44, height: 44)
                    }
                    .disabled(profile == nil || busy)
                    .accessibilityLabel(favourite ? "Remove from favourite" : "Add to favourite")
                    .accessibilityIdentifier("vm.profile.favourite")
                    Menu {
                        Button { Task { await toggle(favourite: false) } } label: {
                            Label(emergency ? "Remove from emergency" : "Add to emergency", systemImage: "exclamationmark.triangle")
                        }
                    } label: {
                        Image(systemName: "ellipsis").font(.system(size: 17, weight: .semibold)).foregroundStyle(VMColor.navy)
                            .frame(width: 44, height: 44)
                    }
                    .disabled(profile == nil || busy)
                    .accessibilityLabel("More actions")
                }
            }
            .padding(.horizontal, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    hero
                    VStack(alignment: .leading, spacing: 0) { sections }
                        .padding(24)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: ScheduleTokens.sheetRadius, style: .continuous).fill(Color.white))
                        .padding(.top, 20)
                }
                .padding(.top, 12)
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom) {
            BottomAction {
                VStack(spacing: 8) {
                    if !selectionContext && !canSend && !store.loading {
                        Text("Your account cannot send shift offers.").scheduleType(ScheduleType.caption)
                    }
                    PrimaryButton(selectionContext ? "Select Staff" : "Send Offer", background: VMColor.navy) { primary() }
                        .disabled(gone || (!selectionContext && !canSend))
                        .accessibilityIdentifier("vm.profile.primary")
                }
            }
            .background(Color.white.ignoresSafeArea())
        }
        .task { await load() }
        .vmDestination($sendStaff) { staff in VMSendShiftView(initialStaff: staff, onSubmitted: nil) }
        .accessibilityIdentifier("vm.staffProfile")
    }

    private var hero: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 8) {
                Text(shown.name.uppercased())
                    .font(.system(.largeTitle, design: .default).weight(.black))
                    .foregroundStyle(VMColor.navy)
                    .lineLimit(3)
                    .minimumScaleFactor(0.6)
                    .accessibilityLabel(shown.name)
                    .accessibilityAddTraits(.isHeader)
                if let role = profile?.jobRoleName ?? shown.jobRoleName {
                    Text(role).scheduleType(ScheduleType.body.colored(VMColor.reportMuted))
                }
                if favourite { tagLine("heart.fill", VMColor.favourite, "Favourited") }
                if emergency { tagLine("exclamationmark.triangle.fill", VMColor.emergency, "Emergency cover") }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Text(InitialsAvatar.initials(for: shown.name))
                .font(.system(size: 44, weight: .bold))
                .foregroundStyle(VMColor.navy)
                .frame(width: 128, height: 128)
                .background(RoundedRectangle(cornerRadius: 34, style: .continuous).fill(VMColor.avatarFill))
                .accessibilityHidden(true)
        }
        .padding(.horizontal, 24)
    }

    private func tagLine(_ icon: String, _ color: Color, _ text: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: icon).foregroundStyle(color).accessibilityHidden(true)
            Text(text).scheduleType(ScheduleType.bodyStrong.colored(VMColor.navy))
        }
    }

    @ViewBuilder
    private var sections: some View {
        if let error {
            let forbidden = (error as? APIError)?.statusCode == 403
            if gone || forbidden {
                MessageCard(title: VMDirectory.errorMessage(error, viewing: true), kind: .error)
            } else {
                MessageCard(title: VMDirectory.errorMessage(error, viewing: true), kind: .error, actionTitle: "Retry") {
                    Task { await load() }
                }
            }
        } else if let profile {
            VMStaffWorkProfile(profile: profile)
            if !profile.skills.isEmpty {
                sectionHeader("SKILLS")
                VMFlowChips(items: profile.skills)
            }
            sectionHeader("AVAILABILITY")
            let hasAvailability = !profile.availableDays.isEmpty || profile.preferredShiftTimes != nil || profile.maxHoursPerWeek != nil
            if !hasAvailability { notProvided }
            if !profile.availableDays.isEmpty { VMDaysRow(days: profile.availableDays) }
            if hasAvailability && profile.availableDays.isEmpty { ReportField("Days", "Not provided") }
            if let preferred = profile.preferredShiftTimes { ReportField("Preferred shift", preferred).padding(.top, 8) }
            if let max = profile.maxHoursPerWeek { ReportField("Maximum hours", "\(max) hrs/week") }
        } else {
            VMInlineLoading(label: "Loading profile")
        }
    }

    private var notProvided: some View {
        Text("Not provided").scheduleType(ScheduleType.secondary).padding(.vertical, 4)
    }

    private func sectionHeader(_ title: String) -> some View {
        Text(title).scheduleType(ScheduleType.overline).padding(.top, 20).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
    }

    private func primary() {
        if selectionContext {
            onSelect?()
            dismiss()
        } else {
            sendStaff = [shown]
        }
    }

    @MainActor
    private func load() async {
        error = nil
        profile = nil
        do {
            profile = try await store.repository.staffProfile(user.id)
        } catch {
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            self.error = error
            if VMDirectory.isNotAssigned(error) { reportGone() }
        }
    }

    private func reportGone() {
        guard !goneReported else { return }
        goneReported = true
        onGone?()
    }

    /// Sends only the tag being changed; renders the server-confirmed state.
    @MainActor
    private func toggle(favourite toggleFavourite: Bool) async {
        guard let currentProfile = profile, !busy else { return }
        busy = true
        defer { busy = false }
        do {
            let tags = toggleFavourite
                ? try await store.repository.setTags(currentProfile.id, favourite: !currentProfile.isFavourite)
                : try await store.repository.setTags(currentProfile.id, emergency: !currentProfile.isEmergency)
            profile = currentProfile.withTags(tags)
            let next = shown.withTags(tags)
            current = next
            onChanged?(next)
        } catch {
            if VMDirectory.isNotAssigned(error) {
                // The inline state replaces the profile; no duplicate toast.
                self.error = error
                reportGone()
            } else if (error as? APIError)?.isUncertainOutcome == true {
                toasts.showError(error)
                await load()
            } else {
                toasts.show(VMDirectory.errorMessage(error, viewing: false), kind: .error)
            }
        }
    }
}

/// WORK PROFILE rows: only the values the server returned.
struct VMStaffWorkProfile: View {
    let profile: VenueStaffProfile

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("WORK PROFILE").scheduleType(ScheduleType.overline).padding(.bottom, 8).accessibilityAddTraits(.isHeader)
            if profile.jobRoleName == nil && profile.employmentType == nil && profile.yearsExperience == nil {
                Text("Not provided").scheduleType(ScheduleType.secondary).padding(.vertical, 4)
            }
            if let role = profile.jobRoleName { ReportField("Primary role", role) }
            if let type = profile.employmentType { ReportField("Employment type", VMText.humanizeToken(type)) }
            if let years = profile.yearsExperience { ReportField("Experience", VMText.yearsLabel(years)) }
        }
    }
}

/// Monday…Sunday squares; declared days are navy.
struct VMDaysRow: View {
    let days: [String]

    var body: some View {
        let lower = Set(days.map { $0.lowercased() })
        HStack(spacing: 6) {
            ForEach(VMText.weekdays, id: \.self) { day in
                let on = lower.contains(day.lowercased())
                Text(String(day.prefix(1)))
                    .font(.system(size: 14, weight: .bold))
                    .foregroundStyle(on ? Color.white : RGBA(argb: 0xFF9CA3AF).color)
                    .frame(maxWidth: .infinity)
                    .aspectRatio(1, contentMode: .fit)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(on ? VMColor.navy : RGBA(argb: 0xFFF1F1F3).color))
                    .accessibilityElement()
                    .accessibilityLabel("\(day): \(on ? "available" : "not listed")")
            }
        }
    }
}

/// Wrapping chips (skills).
struct VMFlowChips: View {
    let items: [String]

    var body: some View {
        VMFlowLayout(spacing: 8) {
            ForEach(items, id: \.self) { item in
                Text(item).scheduleType(ScheduleType.secondary.colored(VMColor.navy))
                    .padding(.horizontal, 14).padding(.vertical, 8)
                    .background(Capsule().fill(RGBA(argb: 0xFFF1F0EC).color))
            }
        }
    }
}

/// Minimal wrapping layout (iOS 16 `Layout`).
struct VMFlowLayout: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0, maxX: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > 0, x + size.width > width {
                x = 0
                y += rowHeight + spacing
                rowHeight = 0
            }
            x += size.width + spacing
            maxX = max(maxX, x - spacing)
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: proposal.width ?? maxX, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if x > bounds.minX, x + size.width > bounds.maxX {
                x = bounds.minX
                y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(size))
            x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
