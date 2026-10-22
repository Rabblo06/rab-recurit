import PDFKit
import SwiftUI
import UIKit

/// One of the staff member's own payroll documents (payslip or approved
/// shift statement). Bytes come only from `GET /files/:id/download` via
/// `APIClient.downloadFile` (a storage redirect is followed WITHOUT the
/// bearer); the server answers 404 to anyone else. The bytes must carry the
/// `%PDF-` magic or nothing is shown.
///
/// The PDF stays in memory. A file is written ONLY when the person taps
/// "Share PDF": into the per-session protected directory (`TemporaryFiles`,
/// complete file protection, purged on sign-out) and deleted again when the
/// share sheet closes or the screen goes away.
struct StaffDocumentScreen: View {
    let fileId: String
    let filename: String?
    let title: String

    @EnvironmentObject private var store: StaffStore
    @EnvironmentObject private var environment: AppEnvironment
    @EnvironmentObject private var toasts: ToastCenter

    @State private var document: DownloadedFile?
    @State private var error: String?
    @State private var share: StaffShareItem?
    @State private var preparingShare = false

    var body: some View {
        VStack(spacing: 0) {
            StaffScreenHeader(title: title)
            Group {
                if let error {
                    MessageCard(title: "Document unavailable", message: error, kind: .error, actionTitle: "Retry") {
                        Task { await load() }
                    }
                    .padding(20)
                    .frame(maxHeight: .infinity, alignment: .top)
                    .accessibilityIdentifier("staff.document.error")
                } else if let document {
                    StaffPDFView(data: document.data)
                        .accessibilityLabel("\(title) PDF")
                } else {
                    LoadingView("Loading document")
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if document != nil {
                BottomAction {
                    PrimaryButton("Share PDF", systemImage: "square.and.arrow.up", isBusy: preparingShare) { prepareShare() }
                        .accessibilityIdentifier("staff.document.share")
                }
                .background(ScheduleTokens.background.ignoresSafeArea(edges: .bottom))
            }
        }
        .background(ScheduleTokens.background.ignoresSafeArea())
        .task { await load() }
        .sheet(item: $share, onDismiss: removeSharedFile) { item in
            StaffActivityView(items: [item.url])
        }
        .onDisappear { removeSharedFile() }
        .staffPushedScreen()
        .accessibilityIdentifier("staff.document")
    }

    private func load() async {
        error = nil
        document = nil
        do {
            let file = try await store.repository.document(fileId: fileId)
            guard file.isPDF else {
                error = "This document could not be displayed."
                return
            }
            document = file
        } catch {
            guard !StaffStore.ignorable(error) else { return }
            self.error = userMessage(for: error, fallback: "This document could not be opened.")
        }
    }

    /// Explicit action only: write, then offer the system share sheet.
    private func prepareShare() {
        guard let document, !preparingShare else { return }
        preparingShare = true
        defer { preparingShare = false }
        var name = document.filename ?? filename ?? "document.pdf"
        if !name.lowercased().hasSuffix(".pdf") { name += ".pdf" }
        do {
            let url = try environment.temporaryFiles.write(document.data, named: name)
            share = StaffShareItem(url: url)
        } catch {
            // No success toast in the mobile app; only failures.
            toasts.show("The PDF could not be prepared for sharing. Please try again.", kind: .error)
        }
    }

    private func removeSharedFile() {
        if let url = share?.url {
            try? FileManager.default.removeItem(at: url)
        }
        share = nil
    }
}

struct StaffShareItem: Identifiable {
    let url: URL
    var id: String { url.path }
}

/// PDFKit viewer: fits the width, pinch-zoom enabled, no editing.
struct StaffPDFView: UIViewRepresentable {
    let data: Data

    func makeUIView(context: Context) -> PDFView {
        let view = PDFView()
        view.autoScales = true
        view.displayMode = .singlePageContinuous
        view.displayDirection = .vertical
        view.backgroundColor = UIColor.secondarySystemBackground
        view.document = PDFDocument(data: data)
        return view
    }

    /// The bytes never change for one view instance (a reload builds a new one).
    func updateUIView(_ uiView: PDFView, context: Context) {}
}

/// System share sheet (Save to Files, AirDrop, ...), shown on request only.
struct StaffActivityView: UIViewControllerRepresentable {
    let items: [Any]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ uiViewController: UIActivityViewController, context: Context) {}
}
