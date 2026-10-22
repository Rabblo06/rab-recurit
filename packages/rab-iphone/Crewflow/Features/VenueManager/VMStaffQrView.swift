import SwiftUI

/// Venue Manager "Staff Qr-Code" (Flutter `VenueStaffQrScreen`). There is
/// NO QR-token or QR-image endpoint for the manager app (BACKEND_DEPENDENCIES
/// G1); the only server source of the shift QR is the pre-shift attendance
/// sheet PDF (`actions.preShiftDocument`), so the navy frame renders that PDF
/// (pinch to zoom). Nothing is drawn or faked: before the sheet exists,
/// after the QR window closes, or on any failure the frame says so.
struct VMStaffQrView: View {
    let shiftId: String

    enum Phase: Equatable {
        case loading
        case available(Data)
        case notYet(Date?)
        case preparing
        case closed
        case unavailable
        case error(String)
    }

    @EnvironmentObject private var store: VenueManagerStore
    @State private var phase: Phase = .loading
    @State private var generation = 0
    @State private var openSheet: Bool?

    private var available: Bool {
        if case .available = phase { return true }
        return false
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            NavHeader("Your workspace", backgroundColor: .white) {
                if available {
                    Menu {
                        Button("Open attendance sheet") { openSheet = true }
                    } label: {
                        Image(systemName: "ellipsis")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundStyle(ScheduleTokens.ink)
                            .frame(width: 44, height: 44)
                    }
                    .accessibilityLabel("More")
                }
            }
            .padding(.horizontal, 8)
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Staff Qr-Code").scheduleType(ScheduleType.heading).accessibilityAddTraits(.isHeader)
                    Text("Staff align the venue's code inside their scanner frame.").scheduleType(ScheduleType.secondary)
                    frame.padding(.top, 10)
                }
                .padding(.horizontal, 20)
                .frame(maxWidth: ScheduleTokens.contentMaxWidth)
                .frame(maxWidth: .infinity)
            }
            VStack(spacing: 12) {
                Text(available
                     ? "Qr-preview · scan the QR-Code on this attendance sheet to clock-in/out. Pinch to zoom."
                     : "Qr-preview · scan this QR-Code displayed here to clock-in/out the staff.")
                    .scheduleType(ScheduleType.caption)
                    .padding(16)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(RoundedRectangle(cornerRadius: 20, style: .continuous).fill(Color.white))
                PrimaryButton("Back", background: ScheduleTokens.navy) { dismiss() }
            }
            .padding(EdgeInsets(top: 12, leading: 20, bottom: 12, trailing: 20))
        }
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .toolbar(.hidden, for: .navigationBar)
        .task { await load() }
        .vmDestination($openSheet) { _ in VMReportDocumentView(shiftId: shiftId, preShift: true) }
        .accessibilityIdentifier("vm.staffQr")
    }

    @Environment(\.dismiss) private var dismissAction
    private func dismiss() { dismissAction() }

    private var frame: some View {
        ZStack {
            ScheduleTokens.navy
            switch phase {
            case .loading:
                ProgressView().tint(.white).accessibilityLabel("Loading the shift QR")
            case .available(let data):
                VMPDFView(data: data)
                    .background(Color.white)
                    .accessibilityLabel("Shift attendance sheet with the shift QR code")
            case .notYet(let at):
                message("building.2", "QR not available yet",
                        at.map { "The shift QR is available from \(CrewflowDateFormat.timeDay($0))." } ?? "The shift QR appears here before the shift starts.")
            case .preparing:
                message("hourglass", "Preparing the shift QR", "The attendance sheet with the QR is being generated.", retry: true)
            case .closed:
                message("lock", "QR window closed", "This shift's clock-in/out window has closed, so its QR is no longer used.")
            case .unavailable:
                message("building.2", "QR not available for this shift", "The server did not provide a QR for this shift.")
            case .error(let text):
                message("exclamationmark.circle", "QR not available", text, retry: true)
            }
        }
        .aspectRatio(0.86, contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func message(_ icon: String, _ title: String, _ body: String, retry: Bool = false) -> some View {
        VStack(spacing: 10) {
            Image(systemName: icon).font(.system(size: 40)).foregroundStyle(.white).accessibilityHidden(true)
            Text(title).scheduleType(ScheduleType.bodyStrong.colored(.white)).multilineTextAlignment(.center)
            Text(body).scheduleType(ScheduleType.secondary.colored(.white.opacity(0.75))).multilineTextAlignment(.center)
            if retry {
                Button("Retry") { Task { await load() } }
                    .scheduleType(ScheduleType.bodyStrong.colored(.white))
                    .frame(minWidth: 88, minHeight: 48)
            }
        }
        .padding(20)
        .accessibilityElement(children: .contain)
    }

    /// Pure state decision from the report (unit-tested).
    nonisolated static func decide(_ report: ShiftReportDetail) -> Phase? {
        if report.isFinalised || report.qrWindow?.state == "closed" { return .closed }
        guard let actions = report.actions else { return .unavailable }
        if actions.preShiftDocument != nil { return nil } // download it
        return actions.stage == "scheduled" ? .notYet(actions.timesheetAvailableAt) : .preparing
    }

    @MainActor
    private func load() async {
        generation += 1
        let stamp = generation
        phase = .loading
        let repository = store.repository
        do {
            let report = try await store.report(for: shiftId)
            var next = Self.decide(report)
            if next == nil, let doc = report.actions?.preShiftDocument {
                let file = try await repository.downloadDocument(doc.fileId)
                next = file.isPDF ? .available(file.data) : .error("The stored file is not a valid PDF.")
            }
            guard stamp == generation else { return }
            phase = next ?? .unavailable
        } catch {
            guard stamp == generation else { return }
            let api = error as? APIError
            if api == .cancelled || api == .sessionChanged { return }
            phase = .error(api?.statusCode == 404
                           ? "The attendance sheet could not be found. It may still be generating."
                           : vmMessage(error, fallback: "The QR code could not be loaded."))
        }
    }
}
