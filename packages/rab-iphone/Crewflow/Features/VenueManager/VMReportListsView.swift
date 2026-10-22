import SwiftUI

enum VMReportBucket: String {
    case current, history

    var title: String { self == .current ? "Reports" : "History" }
    var heading: String { self == .current ? "Event staffing summaries" : "Past shifts and timesheets" }
    var intro: String {
        self == .current
            ? "Confirmed positions and remaining requirements.\nTap a shift to view attendance."
            : "Completed shifts, expired actions and sent timesheets."
    }
    var emptyTitle: String { self == .current ? "No current reports." : "No historical activity yet." }
    var emptyMessage: String {
        self == .current
            ? "Sent reports move to History five hours after delivery."
            : "Shifts appear here five hours after they end, or five hours after their timesheet is sent."
    }
}

/// Reports (`current`) and History (`history`) — Flutter `VenueReportsScreen`
/// / `VenueHistoryScreen`. Lists are filtered server-side against DB time
/// (five-hour policy); cards read the server lifecycle. History is also the
/// root of the History tab. A failed store refresh (e.g. a revoked
/// permission) replaces the list with the error state.
struct VMReportBucketScreen: View {
    let bucket: VMReportBucket
    let isRoot: Bool

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var toasts: ToastCenter
    @State private var rows: [ReportSummary] = []
    @State private var total = 0
    @State private var page = 0
    @State private var loading = true
    @State private var loadingMore = false
    @State private var error: String?
    @State private var open: String?
    @State private var seenRefresh: Date?

    var body: some View {
        VMPage(title: bucket.title, showBack: !isRoot) {
            if store.loading && store.updatedAt == nil {
                VMInlineLoading()
            } else if let storeError = store.error {
                VMLoadFailure(message: storeError) { Task { await store.refresh() } }
            } else if !store.allows(.reportView) {
                MessageCard(title: "Reports are not available for this account.", kind: .error).padding(ScheduleTokens.homeInset)
            } else if loading && rows.isEmpty {
                VMInlineLoading(label: "Loading reports")
            } else {
                list
            }
        }
        .task { if page == 0 { await reload() } }
        .onChange(of: store.updatedAt) { refreshed in
            // Re-fetch whenever the store completes a refresh (resume, pull elsewhere).
            guard refreshed != seenRefresh else { return }
            seenRefresh = refreshed
            Task { await reload() }
        }
        .vmDestination($open, onReturn: { Task { await reload() } }) { VMShiftReportView(shiftId: $0) }
        .accessibilityIdentifier("vm.reports.\(bucket.rawValue)")
    }

    private var list: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 16) {
                Text(bucket.heading).scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
                Text(bucket.intro).scheduleType(ScheduleType.caption)
                if let error {
                    MessageCard(title: error, kind: .error, actionTitle: "Retry") { Task { await reload() } }
                }
                if rows.isEmpty && error == nil {
                    MessageCard(title: bucket.emptyTitle, message: bucket.emptyMessage)
                }
                ForEach(rows) { report in
                    VMReportEventCard(report: report) { open = report.shiftId }
                        .onAppear { if report.id == rows.last?.id { Task { await more() } } }
                }
                if loadingMore { VMInlineLoading(label: "Loading more reports") }
            }
            .padding(ScheduleTokens.homeInset)
            .frame(maxWidth: ScheduleTokens.contentMaxWidth)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await reload() }
    }

    @MainActor
    private func reload() async {
        guard store.allows(.reportView) else { return }
        loading = true
        error = nil
        do {
            let result = try await store.repository.reports(bucket: bucket.rawValue)
            rows = result.data
            total = result.total
            page = 1
        } catch {
            let api = error as? APIError
            if api != .cancelled, api != .sessionChanged {
                // Never show an empty list on failure: keep the previous rows, say so.
                self.error = vmMessage(error, fallback: "Could not load reports.")
            }
        }
        loading = false
    }

    @MainActor
    private func more() async {
        guard !loadingMore, page > 0, rows.count < total else { return }
        loadingMore = true
        defer { loadingMore = false }
        do {
            let result = try await store.repository.reports(bucket: bucket.rawValue, page: page + 1)
            let seen = Set(rows.map(\.shiftId))
            rows += result.data.filter { !seen.contains($0.shiftId) }
            total = result.total
            page += 1
        } catch {
            // The loaded rows stay usable; only "load more" failed.
            toasts.showError(error, fallback: "Could not load more reports.")
        }
    }
}

/// Reports / History card (Flutter `ReportEventCard`): lifecycle pill (the
/// server's `displayLabel`) + marker, role, venue, date/time, confirmed/open.
struct VMReportEventCard: View {
    let report: ReportSummary
    let onTap: () -> Void

    var body: some View {
        let life = report.lifecycle
        let look = reportLifecycleLook(life.displayStatus, label: life.displayLabel)
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top) {
                    VMFlowLayout(spacing: 6) {
                        VMPill(tone: look)
                        if let marker = reportMarker(life) {
                            VMPill(marker, background: RGBA(argb: 0xFFFFE4D6).color, foreground: VMColor.missingText)
                        }
                    }
                    Spacer(minLength: 8)
                    Image(systemName: "arrow.up.right").font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(VMColor.navy)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.white))
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(VMText.displayRoleName(report.roleName)).scheduleType(ScheduleType.cardTitle.colored(VMColor.navy))
                    Text(report.venueName).scheduleType(ScheduleType.bodyStrong.colored(RGBA(argb: 0xFF64748B).color))
                }
                HStack(spacing: 18) {
                    ShiftMetaItem(systemImage: "calendar", label: CrewflowDateFormat.weekdayDay(report.startsAt))
                    ShiftMetaItem(systemImage: "clock", label: VMDate.reportTimeRange(report.startsAt, report.endsAt))
                }
                Divider()
                ShiftCardFooterLine("\(report.filledCount) / \(report.requiredCount) confirmed · \(report.open) open")
            }
            .multilineTextAlignment(.leading)
            .padding(EdgeInsets(top: 18, leading: 20, bottom: 18, trailing: 18))
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 24, style: .continuous).fill(look.card.color))
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens the shift report")
        .accessibilityIdentifier("vm.report.card.\(report.shiftId)")
    }
}
