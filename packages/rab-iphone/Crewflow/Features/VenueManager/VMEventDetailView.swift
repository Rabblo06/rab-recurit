import SwiftUI
import UIKit

/// Event Details (Flutter `VenueEventDetail`): status / date / time pills,
/// NOTE, Staffing card (Required | Filled ┊ Clock in | Clock out — report
/// counts, "—" without a report, never 0), confirmed staff, and the bottom
/// Qr-Code + Clock-In/Out actions (`report.view`; the on-behalf punches are
/// further gated by `attendance.edit` inside Teams). The shift and its
/// roster load side by side; a roster failure never hides the event.
struct VMEventDetailView: View {
    let event: VenueEvent

    private enum Destination {
        case teams(VenueEvent)
        case qr(String)
        case review(ShiftReportDetail, ShiftReportStaffRow)
    }

    @EnvironmentObject private var store: VenueManagerStore
    @State private var loaded: VenueEvent?
    @State private var error: String?
    @State private var roster: ShiftRoster?
    @State private var rosterError: String?
    @State private var rosterLoading = true
    @State private var generation = 0
    @State private var destination: Destination?

    private var style: ShiftVisualStyle { ShiftVisualStyle.forShift(event.id) }

    var body: some View {
        VStack(spacing: 0) {
            NavHeader("Event Details", backgroundColor: .white).padding(.horizontal, 8)
            if let error {
                VMLoadFailure(message: error) { Task { await load() } }
                Spacer()
            } else if let current = loaded {
                ScrollView {
                    content(current)
                        .padding(EdgeInsets(top: 12, leading: 20, bottom: 32, trailing: 20))
                        .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                        .frame(maxWidth: .infinity)
                }
                .refreshable { await load() }
            } else {
                VMInlineLoading(label: "Loading event")
                Spacer()
            }
        }
        .background(style.page.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .safeAreaInset(edge: .bottom) {
            if let current = loaded, error == nil, showsAttendanceActions(current) {
                BottomAction {
                    HStack(spacing: 12) {
                        PrimaryButton("Qr-Code", variant: .light) { destination = .qr(current.id) }
                            .accessibilityIdentifier("vm.event.qr")
                        PrimaryButton("Clock-In/Out") { destination = .teams(current) }
                            .accessibilityIdentifier("vm.event.clock")
                    }
                }
                .background(style.page.opacity(0.96).ignoresSafeArea())
            }
        }
        .task { await load() }
        .vmDestination($destination, onReturn: { Task { await load() } }) { destination in
            switch destination {
            case .teams(let event): VMTeamsView(event: event)
            case .qr(let shiftId): VMStaffQrView(shiftId: shiftId)
            case .review(let report, let row): VMReviewStaffReportView(report: report, row: row)
            }
        }
        .accessibilityIdentifier("vm.eventDetail")
    }

    /// Both read the shift report (`report.view`); not for cancelled, draft
    /// or completed shifts.
    private func showsAttendanceActions(_ e: VenueEvent) -> Bool {
        store.allows(.reportView) && !["cancelled", "draft", "completed"].contains(e.status)
    }

    @MainActor
    private func load() async {
        generation += 1
        let stamp = generation
        error = nil
        rosterError = nil
        rosterLoading = true
        let store = self.store
        let repository = store.repository
        let shiftId = event.id
        async let shiftResult = vmSettle { try await repository.shift(shiftId) }
        async let rosterResult = vmSettle { try await store.roster(for: shiftId) }
        let (shift, shiftError) = await shiftResult
        guard stamp == generation else { return }
        if let shift {
            loaded = event.replacing(shift)
        } else if let shiftError, !isCancellation(shiftError) {
            error = vmMessage(shiftError, fallback: "Unable to load event.")
        }
        let (nextRoster, failure) = await rosterResult
        guard stamp == generation else { return }
        roster = nextRoster
        rosterError = failure.flatMap { isCancellation($0) ? nil : vmMessage($0, fallback: "Unable to load confirmed staff.") }
        rosterLoading = false
    }

    private func isCancellation(_ error: Error) -> Bool {
        let api = error as? APIError
        return api == .cancelled || api == .sessionChanged
    }

    @ViewBuilder
    private func content(_ e: VenueEvent) -> some View {
        let notes = e.notes.trimmingCharacters(in: .whitespacesAndNewlines)
        let status = reportEventLook(e.status)
        let report = roster?.report
        VStack(spacing: 0) {
            VMVenuePhoto(fileId: e.shift.venuePhotoFileId, size: 76, circle: true, placeholder: .white, label: "\(e.venue) photo")
                .padding(3)
                .background(Circle().fill(Color.white))
            Text(e.role).scheduleType(ScheduleType.pageTitle).multilineTextAlignment(.center).padding(.top, 16)
            Text(e.venue).scheduleType(ScheduleType.body).multilineTextAlignment(.center).padding(.top, 4)
            if !e.address.isEmpty {
                Text(e.address).scheduleType(ScheduleType.secondary).multilineTextAlignment(.center)
            }
            VMWrapPills(items: [
                (e.status == "fully_filled" ? "checkmark" : nil, status.label),
                (nil, CrewflowDateFormat.fullDay(e.start)),
                (nil, VMDate.eventTime(e.start, e.end)),
            ], style: style)
            .padding(.top, 14)

            Text("NOTE").scheduleType(ScheduleType.overline)
                .frame(width: 150)
                .padding(.vertical, 8)
                .background(VMTopRoundedShape(radius: 14).fill(style.badgeSurface.opacity(0.6)))
                .padding(.top, 20)
            Group {
                if notes.isEmpty {
                    HStack(spacing: 10) {
                        Image(systemName: "text.alignleft").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
                        Text("No details provided").scheduleType(ScheduleType.secondary)
                        Spacer(minLength: 0)
                    }
                } else {
                    Text(notes).scheduleType(ScheduleType.body).frame(maxWidth: .infinity, alignment: .leading)
                }
            }
            .padding(18)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(Color.white))

            // Group: keeps this VStack within ViewBuilder's 10-child limit
            // (the variadic builder needs iOS 17). Layout is unchanged.
            Group {
                VMSectionHeader("Staffing").padding(.top, 22)
                VMStaffingCard(values: [
                    ("Required", "\(e.required)"),
                    ("Filled", "\(e.filled)"),
                    ("Clock in", report.map { "\($0.clockedIn)" } ?? "—"),
                    ("Clock out", report.map { "\($0.clockedOut)" } ?? "—"),
                ])

                VMSectionHeader(title: "Confirmed staff") {
                    if let roster {
                        Text("\(roster.confirmedCount)").scheduleType(ScheduleType.badge)
                            .padding(.horizontal, 9).padding(.vertical, 3)
                            .background(Capsule().fill(Color.white))
                    }
                }
                .padding(.top, 18)
                VStack(spacing: 10) { rosterRows }
            }
        }
    }

    @ViewBuilder
    private var rosterRows: some View {
        if roster == nil && rosterLoading {
            VMInlineLoading(label: "Loading confirmed staff")
        } else if let roster {
            if roster.members.isEmpty {
                MessageCard(title: "No confirmed staff yet.")
            }
            ForEach(roster.members) { member in
                Button {
                    if let report = roster.report, let row = member.row { destination = .review(report, row) }
                } label: {
                    VMStaffRow(name: member.name, role: member.role) {
                        if member.isNoShow {
                            VMPill.booking(member)
                        } else {
                            Image(systemName: "checkmark")
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(ShiftVisualStyle.mint.badgeText)
                                .frame(width: 26, height: 26)
                                .background(Circle().fill(ShiftVisualStyle.mint.badgeSurface))
                                .accessibilityLabel("Confirmed")
                        }
                    }
                }
                .buttonStyle(PressableButtonStyle())
                .disabled(member.row == nil)
                .accessibilityHint(member.row == nil ? "" : "Opens the attendance review")
            }
        } else {
            MessageCard(title: "Confirmed staff unavailable", message: rosterError ?? "Unable to load confirmed staff.",
                        kind: .error, actionTitle: "Retry") { Task { await load() } }
        }
    }
}

/// Status / date / time pills that wrap onto several lines.
struct VMWrapPills: View {
    let items: [(String?, String)]
    let style: ShiftVisualStyle

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) { pills }
            VStack(spacing: 8) { pills }
        }
    }

    private var pills: some View {
        ForEach(Array(items.enumerated()), id: \.offset) { _, item in
            HStack(spacing: 6) {
                if let icon = item.0 { Image(systemName: icon).font(.system(size: 13, weight: .bold)).accessibilityHidden(true) }
                Text(item.1).scheduleType(ScheduleType.badge.colored(ScheduleTokens.ink))
            }
            .foregroundStyle(ScheduleTokens.ink)
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(Capsule().fill(Color.white.opacity(0.85)))
            .overlay(Capsule().stroke(style.cardBorder, lineWidth: 1))
        }
    }
}

/// Required | Filled ┊ Clock in | Clock out; two rows of two when four
/// columns would not fit.
struct VMStaffingCard: View {
    let values: [(String, String)]

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                pair(Array(values.prefix(2)))
                Divider().frame(height: 40).padding(.horizontal, 10)
                pair(Array(values.dropFirst(2)))
            }
            VStack(spacing: 10) {
                pair(Array(values.prefix(2)))
                Divider()
                pair(Array(values.dropFirst(2)))
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 18, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 18, style: .continuous).stroke(VMColor.rowBorder, lineWidth: 1))
    }

    private func pair(_ two: [(String, String)]) -> some View {
        HStack(spacing: 8) {
            ForEach(Array(two.enumerated()), id: \.offset) { _, entry in
                VStack(alignment: .leading, spacing: 6) {
                    Text(entry.0).scheduleType(ScheduleType.caption).lineLimit(1)
                    Text(entry.1).scheduleType(ScheduleType.cardTitle)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(entry.0): \(entry.1 == "—" ? "unknown" : entry.1)")
            }
        }
        .frame(minWidth: 140)
    }
}

/// Rectangle rounded on the top corners only (the NOTE tab).
struct VMTopRoundedShape: Shape {
    let radius: CGFloat

    func path(in rect: CGRect) -> Path {
        Path(UIBezierPath(roundedRect: rect, byRoundingCorners: [.topLeft, .topRight],
                          cornerRadii: CGSize(width: radius, height: radius)).cgPath)
    }
}
