import SwiftUI

/// Loads both payroll lists for the Payslips screen. Only the caller's own
/// documents; nothing is calculated in the app.
@MainActor
final class StaffPayslipsModel: ObservableObject {
    @Published private(set) var statements: [StaffShiftStatement] = []
    @Published private(set) var payslips: [StaffPayslip] = []
    @Published private(set) var loading = true
    @Published private(set) var error: String?
    @Published var year: Int?

    private let repository: StaffRepository
    private let fence: StaffSessionFence

    init(repository: StaffRepository, fence: StaffSessionFence) {
        self.repository = repository
        self.fence = fence
    }

    func load() async {
        loading = true
        error = nil
        let epoch = fence.epoch
        do {
            async let statementRows = repository.statements()
            async let payslipRows = repository.payslips()
            let (loadedStatements, loadedPayslips) = try await (statementRows, payslipRows)
            guard fence.isCurrent(epoch) else { return }
            statements = loadedStatements.sorted { $0.startsAt > $1.startsAt }
            payslips = loadedPayslips.sorted { $0.payday > $1.payday }
        } catch {
            guard fence.isCurrent(epoch), !StaffStore.ignorable(error) else { return }
            self.error = userMessage(for: error, fallback: "Your payroll documents could not be loaded.")
        }
        loading = false
    }

    var years: [Int] {
        let calendar = StaffFormat.london
        return Array(Set(statements.map { calendar.component(.year, from: $0.startsAt) })).sorted(by: >)
    }

    func shownYear(fallback: Date) -> Int {
        year ?? years.first ?? StaffFormat.london.component(.year, from: fallback)
    }

    func statements(in year: Int) -> [StaffShiftStatement] {
        let calendar = StaffFormat.london
        return statements.filter { calendar.component(.year, from: $0.startsAt) == year }
    }
}

/// Payslips (Flutter `PayslipsScreen`): navy summary card, Official payslips
/// (`/payroll/me/payslips`) and Approved shift statements
/// (`/payroll/me/statements`). Approval is not payment: nothing says "Paid"
/// unless the server reports a confirmed payment, and net pay is only ever
/// the provider document's figure.
struct StaffPayslipsScreen: View {
    @EnvironmentObject private var store: StaffStore

    var body: some View {
        StaffPayslipsContent(repository: store.repository, fence: store.sessionFence, now: store.displayNow)
    }
}

private struct StaffPayslipsContent: View {
    @StateObject private var model: StaffPayslipsModel
    @EnvironmentObject private var navigator: StaffNavigator
    let now: Date

    init(repository: StaffRepository, fence: StaffSessionFence, now: Date) {
        _model = StateObject(wrappedValue: StaffPayslipsModel(repository: repository, fence: fence))
        self.now = now
    }

    var body: some View {
        VStack(spacing: 0) {
            StaffScreenHeader(title: "Payslips")
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    if model.loading && model.statements.isEmpty && model.payslips.isEmpty {
                        ProgressView().frame(maxWidth: .infinity).padding(48)
                    } else if let error = model.error {
                        MessageCard(title: "Payslips unavailable", message: error, kind: .error, actionTitle: "Retry") {
                            Task { await model.load() }
                        }
                        .accessibilityIdentifier("staff.payslips.error")
                    } else {
                        loaded
                    }
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 32)
            }
            .refreshable { await model.load() }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .task { await model.load() }
        .staffPushedScreen()
        .accessibilityIdentifier("staff.payslips")
    }

    @ViewBuilder
    private var loaded: some View {
        let year = model.shownYear(fallback: now)
        let shown = model.statements(in: year)
        StaffPayslipSummaryCard(
            latest: model.statements.first,
            payslip: model.payslips.first(where: \.hasDocument),
            nextPayday: StaffPayrollRules.nextPayday(model.payslips),
            onOpenPayslip: open
        )
        sectionTitle("Official payslips").padding(.top, 24).padding(.bottom, 12)
        if model.payslips.isEmpty {
            emptyRow(icon: "doc.plaintext", title: "No official payslips available yet",
                     message: "Your fortnightly payslips appear here once your agency publishes them.")
        } else {
            StaffGroup {
                ForEach(Array(model.payslips.enumerated()), id: \.element.id) { index, payslip in
                    if index > 0 { Divider().overlay(ScheduleTokens.border) }
                    payslipRow(payslip)
                }
            }
        }
        HStack {
            sectionTitle("Approved shift statements")
            Spacer()
            if model.years.count > 1 {
                Menu {
                    ForEach(model.years, id: \.self) { option in
                        Button(String(option)) { model.year = option }
                    }
                } label: {
                    yearChip(year)
                }
                .accessibilityLabel("Choose year, \(year)")
            } else {
                yearChip(year)
            }
        }
        .padding(.top, 24)
        .padding(.bottom, 12)
        if shown.isEmpty {
            emptyRow(icon: "doc.text", title: "No approved shift statements yet",
                     message: "A statement appears here once your manager approves the payroll for a shift.")
        } else {
            StaffGroup {
                ForEach(Array(shown.enumerated()), id: \.element.id) { index, statement in
                    if index > 0 { Divider().overlay(ScheduleTokens.border) }
                    statementRow(statement)
                }
            }
        }
        Text("Statements confirm approved shift earnings. They are not proof of payment; pay arrives on the agency payday.")
            .scheduleType(ScheduleType.caption)
            .padding(.top, 14)
    }

    private func open(_ payslip: StaffPayslip) {
        guard let document = payslip.document else { return }
        navigator.push(.document(fileId: document.fileId, filename: document.filename, title: "Payslip"))
    }

    private func sectionTitle(_ text: String) -> some View {
        Text(text).scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
    }

    private func yearChip(_ year: Int) -> some View {
        HStack(spacing: 8) {
            Text(String(year)).scheduleType(ScheduleType.secondary)
            Image(systemName: "calendar").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 8)
        .frame(minHeight: 44)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
    }

    private func emptyRow(icon: String, title: String, message: String) -> some View {
        HStack(alignment: .top, spacing: 14) {
            StaffDocIcon(icon: icon, muted: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).scheduleType(ScheduleType.bodyStrong)
                Text(message).scheduleType(ScheduleType.caption)
            }
            Spacer(minLength: 0)
        }
        .padding(18)
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
        .overlay(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).stroke(ScheduleTokens.border, lineWidth: 1))
        .accessibilityElement(children: .combine)
    }

    private func payslipRow(_ payslip: StaffPayslip) -> some View {
        let pill = StaffPayrollRules.pill(payslip.status)
        let line: String
        if payslip.status == "paid", let paidAt = payslip.paidAt {
            line = "Paid \(CrewflowDateFormat.day(paidAt))"
        } else {
            line = "\(pill.label) · payday \(StaffFormat.day(payslip.payday))"
        }
        return StaffDocumentRow(
            title: payslip.period.label,
            lines: [line],
            amount: payslip.netPence.map(Money.formatPence) ?? "—",
            action: payslip.hasDocument ? "View ›" : "Not available yet",
            actionColor: nil,
            hasDocument: payslip.hasDocument,
            onTap: payslip.hasDocument ? { open(payslip) } : nil
        )
    }

    private func statementRow(_ statement: StaffShiftStatement) -> some View {
        var onTap: (() -> Void)?
        if let fileId = statement.documentFileId {
            onTap = { navigator.push(.document(fileId: fileId, filename: statement.statement?.filename, title: "Shift statement")) }
        }
        return StaffDocumentRow(
            title: StaffFormat.weekdayDayYear(statement.startsAt),
            lines: [statement.venueName, StaffPayrollRules.paydayText(statement.payday)],
            amount: statement.amountPence.map(Money.formatPence) ?? "—",
            action: StaffPayrollRules.statementAction(statement),
            actionColor: statement.statementState == "failed" ? ScheduleTokens.errorText : nil,
            hasDocument: statement.isAvailable,
            onTap: onTap
        )
    }
}

/// Latest official payslip with a document when there is one; otherwise the
/// latest approved shift. The labels say which, so approval never reads as pay.
struct StaffPayslipSummaryCard: View {
    let latest: StaffShiftStatement?
    let payslip: StaffPayslip?
    let nextPayday: CalendarDay?
    let onOpenPayslip: (StaffPayslip) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text(heading).scheduleType(ScheduleType.secondary.colored(.white))
                Spacer()
                if let status = payslip?.status ?? latest?.status {
                    StaffStatusPill(status: status)
                }
            }
            if let amount {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .lastTextBaseline, spacing: 10) { amountText(amount, amountLabel) }
                    VStack(alignment: .leading, spacing: 2) { amountText(amount, amountLabel) }
                }
            } else {
                Text("Nothing approved yet").staffFont(24, .bold).foregroundStyle(.white)
            }
            Text(detail).scheduleType(ScheduleType.body.colored(.white))
            if let footer {
                if let payslip {
                    Button { onOpenPayslip(payslip) } label: {
                        Text(footer).scheduleType(ScheduleType.caption.colored(Color.white.opacity(0.75)))
                            .frame(minHeight: 44, alignment: .leading)
                    }
                    .buttonStyle(.plain)
                } else {
                    Text(footer).scheduleType(ScheduleType.caption.colored(Color.white.opacity(0.75)))
                }
            }
        }
        .padding(EdgeInsets(top: 18, leading: 20, bottom: 20, trailing: 20))
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.cardRadius, style: .continuous).fill(ScheduleTokens.navy))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("staff.payslips.summary")
    }

    @ViewBuilder
    private func amountText(_ amount: String, _ label: String) -> some View {
        Text(amount)
            .font(.system(size: 40, weight: .bold).monospacedDigit())
            .foregroundStyle(.white)
            .lineLimit(1)
            .minimumScaleFactor(0.6)
        Text(label).scheduleType(ScheduleType.secondary.colored(Color.white.opacity(0.75)))
    }

    private var heading: String {
        if payslip != nil { return "Latest payslip" }
        return latest != nil ? "Latest approved shift" : "Approved earnings"
    }

    /// The provider document's net figure for a payslip ("—" until it has
    /// one), else the latest approved gross. Never computed here.
    private var amount: String? {
        if let payslip {
            guard let net = payslip.netPence else { return "—" }
            return Money.formatPence(net)
        }
        guard let gross = latest?.amountPence else { return nil }
        return Money.formatPence(gross)
    }

    private var amountLabel: String {
        guard let payslip else { return "Approved gross" }
        return payslip.netPence == nil ? "Net pay on payslip" : "Net pay"
    }

    private var detail: String {
        if let payslip { return payslip.period.label }
        if let latest { return "\(StaffFormat.longDay(latest.startsAt)) · \(latest.venueName)" }
        return "Approved shift earnings appear here after your manager approves payroll."
    }

    private var footer: String? {
        if let payslip {
            let when = payslip.status == "paid" && payslip.paidAt != nil
                ? "Paid on \(CrewflowDateFormat.day(payslip.paidAt!))"
                : "Payday \(StaffFormat.day(payslip.payday))"
            return "\(when) · View payslip ↗"
        }
        if let nextPayday { return "Next payday \(StaffFormat.day(nextPayday, year: true))" }
        if let latest { return StaffPayrollRules.paydayText(latest.payday) }
        return nil
    }
}

struct StaffStatusPill: View {
    let status: String

    var body: some View {
        let pill = StaffPayrollRules.pill(status)
        Text(pill.label)
            .scheduleType(ScheduleType.badge.colored(pill.text.color))
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(pill.surface.color))
    }
}

struct StaffDocIcon: View {
    var icon = "doc.text"
    var muted = false

    var body: some View {
        Image(systemName: icon)
            .staffFont(20)
            .foregroundStyle(muted ? ScheduleTokens.muted : StaffPalette.docGreen)
            .frame(width: 44, height: 44)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(muted ? StaffPalette.neutralTone : StaffPalette.docGreenSurface))
            .accessibilityHidden(true)
    }
}

struct StaffDocumentRow: View {
    let title: String
    let lines: [String]
    let amount: String
    let action: String
    let actionColor: Color?
    let hasDocument: Bool
    let onTap: (() -> Void)?

    var body: some View {
        Button { onTap?() } label: {
            HStack(spacing: 14) {
                StaffDocIcon(muted: !hasDocument)
                VStack(alignment: .leading, spacing: 1) {
                    Text(title).scheduleType(ScheduleType.bodyStrong)
                    ForEach(lines, id: \.self) { line in
                        Text(line).scheduleType(ScheduleType.caption).lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 1) {
                    Text(amount).scheduleType(ScheduleType.bodyStrong)
                    Text(action).scheduleType(ScheduleType.caption.colored(actionColor ?? ScheduleTokens.muted))
                }
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 14)
            .frame(minHeight: 60)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(onTap == nil)
        .accessibilityElement(children: .combine)
        .accessibilityHint(onTap == nil ? "" : "Opens the document")
    }
}
