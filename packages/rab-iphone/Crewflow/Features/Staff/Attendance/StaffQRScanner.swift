import AVFoundation
import SwiftUI
import UIKit

/// Native venue-QR scanner (AVFoundation `AVCaptureMetadataOutput`, `.qr`).
///
/// Security / privacy rules:
/// - The scanned text is the signed shift token. It is returned VERBATIM to
///   the caller and never parsed, validated, stored or logged here.
/// - Exactly one value is delivered: the first non-empty code stops the
///   session; later frames are ignored (de-duplication).
/// - The capture session stops when the screen disappears, when the app
///   leaves the foreground, and when the view is torn down.
struct StaffQRScanScreen: View {
    let title: String
    let onFinish: (String?) -> Void

    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openURL) private var openURL
    @State private var permission: AVAuthorizationStatus = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var cameraFailed = false
    @State private var running = true

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            NavHeader("Your workspace", backgroundColor: .clear, onBack: { onFinish(nil) })
            ScrollView {
                VStack(alignment: .leading, spacing: 8) {
                    Text(title)
                        .scheduleType(ScheduleType.heading)
                        .accessibilityAddTraits(.isHeader)
                    Text("Align the venue’s code inside the frame.")
                        .scheduleType(ScheduleType.caption)
                    camera
                        .aspectRatio(1.186, contentMode: .fit)
                        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
                        .padding(.top, 10)
                }
            }
            Text("Camera preview · scan the QR displayed at your venue.")
                .scheduleType(ScheduleType.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(RoundedRectangle(cornerRadius: ScheduleTokens.rowRadius, style: .continuous).fill(Color.white))
            PrimaryButton("Cancel scan", variant: .light) { onFinish(nil) }
                .accessibilityIdentifier("staff.qr.cancel")
        }
        .padding(.horizontal, 20)
        .padding(.bottom, 12)
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
        .task { await requestAccessIfNeeded() }
        .onChange(of: scenePhase) { phase in
            running = phase == .active
        }
        .onDisappear { running = false }
    }

    @ViewBuilder
    private var camera: some View {
        ZStack {
            ScheduleTokens.navy
            switch permission {
            case .authorized where !cameraFailed:
                StaffQRCameraView(running: running, onCode: { code in
                    running = false
                    onFinish(code)
                }, onFailure: {
                    cameraFailed = true
                })
                .accessibilityLabel("Camera preview for the venue QR code")
                StaffScanCorners()
                    .stroke(Color.white, lineWidth: 2)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            case .notDetermined:
                ProgressView().tint(.white)
            default:
                MessageCard(
                    title: "Camera unavailable",
                    message: "Check camera access in Settings, then try again.",
                    kind: .error,
                    actionTitle: permission == .authorized ? "Retry" : "Open Settings"
                ) {
                    if permission == .authorized {
                        cameraFailed = false
                        running = true
                    } else if let url = URL(string: UIApplication.openSettingsURLString) {
                        openURL(url)
                    }
                }
                .padding(20)
            }
        }
    }

    @MainActor
    private func requestAccessIfNeeded() async {
        guard permission == .notDetermined else { return }
        let granted = await AVCaptureDevice.requestAccess(for: .video)
        permission = granted ? .authorized : .denied
    }
}

/// Corner brackets around the scan area (Flutter `_ScanCorners`).
struct StaffScanCorners: Shape {
    func path(in rect: CGRect) -> Path {
        let box = CGRect(x: rect.midX - rect.width * 0.39 / 2, y: rect.midY - rect.height * 0.62 / 2,
                         width: rect.width * 0.39, height: rect.height * 0.62)
        var path = Path()
        let arm: CGFloat = 8
        for (corner, dx, dy) in [
            (CGPoint(x: box.minX, y: box.minY), CGFloat(1), CGFloat(1)),
            (CGPoint(x: box.maxX, y: box.minY), CGFloat(-1), CGFloat(1)),
            (CGPoint(x: box.minX, y: box.maxY), CGFloat(1), CGFloat(-1)),
            (CGPoint(x: box.maxX, y: box.maxY), CGFloat(-1), CGFloat(-1)),
        ] {
            path.move(to: CGPoint(x: corner.x + dx * arm, y: corner.y))
            path.addLine(to: corner)
            path.addLine(to: CGPoint(x: corner.x, y: corner.y + dy * arm))
        }
        return path
    }
}

/// The capture session behind the scanner.
struct StaffQRCameraView: UIViewRepresentable {
    let running: Bool
    let onCode: (String) -> Void
    let onFailure: () -> Void

    func makeCoordinator() -> Coordinator {
        Coordinator(onCode: onCode, onFailure: onFailure)
    }

    func makeUIView(context: Context) -> PreviewView {
        let view = PreviewView()
        view.backgroundColor = .black
        context.coordinator.configure(preview: view)
        return view
    }

    func updateUIView(_ uiView: PreviewView, context: Context) {
        context.coordinator.onCode = onCode
        context.coordinator.setRunning(running)
    }

    static func dismantleUIView(_ uiView: PreviewView, coordinator: Coordinator) {
        coordinator.setRunning(false)
    }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        var onCode: (String) -> Void
        let onFailure: () -> Void
        private let session = AVCaptureSession()
        private let queue = DispatchQueue(label: "crewflow.staff.qr-session")
        private var configured = false
        /// Main-thread only. Once true, no further frame is ever delivered.
        private var delivered = false

        init(onCode: @escaping (String) -> Void, onFailure: @escaping () -> Void) {
            self.onCode = onCode
            self.onFailure = onFailure
        }

        func configure(preview: PreviewView) {
            preview.previewLayer.session = session
            preview.previewLayer.videoGravity = .resizeAspectFill
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  session.canAddInput(input)
            else {
                DispatchQueue.main.async { [onFailure] in onFailure() }
                return
            }
            session.beginConfiguration()
            session.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard session.canAddOutput(output) else {
                session.commitConfiguration()
                DispatchQueue.main.async { [onFailure] in onFailure() }
                return
            }
            session.addOutput(output)
            output.setMetadataObjectsDelegate(self, queue: .main)
            if output.availableMetadataObjectTypes.contains(.qr) {
                output.metadataObjectTypes = [.qr]
            }
            session.commitConfiguration()
            configured = true
        }

        func setRunning(_ running: Bool) {
            guard configured else { return }
            let session = self.session
            let shouldRun = running && !delivered
            queue.async {
                if shouldRun, !session.isRunning {
                    session.startRunning()
                } else if !shouldRun, session.isRunning {
                    session.stopRunning()
                }
            }
        }

        func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject], from connection: AVCaptureConnection) {
            guard !delivered else { return }
            let value = metadataObjects
                .compactMap { ($0 as? AVMetadataMachineReadableCodeObject)?.stringValue }
                .first { !$0.isEmpty }
            guard let value else { return }
            delivered = true
            setRunningOff()
            onCode(value)
        }

        private func setRunningOff() {
            let session = self.session
            queue.async {
                if session.isRunning { session.stopRunning() }
            }
        }
    }
}
