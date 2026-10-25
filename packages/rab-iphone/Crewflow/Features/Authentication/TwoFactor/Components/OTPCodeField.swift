import SwiftUI

/// `otp()`: ONE real text field behind six painted boxes (UI_PLAN §5).
///
/// - `.textContentType(.oneTimeCode)` + number pad, so iOS offers the code
///   from the Passwords app / autofill, and a long press offers Paste.
/// - Whatever arrives (typed, pasted "482 913", autofilled) is reduced to at
///   most six ASCII digits; the boxes only draw that string.
/// - VoiceOver sees one field with one label and the digits as its value;
///   the boxes are hidden from accessibility.
struct OTPCodeField: View {
    static let length = 6

    @Binding var code: String
    let label: String
    let isError: Bool
    let identifier: String
    let autoFocus: Bool
    let onComplete: (() -> Void)?

    @FocusState private var focused: Bool

    init(
        code: Binding<String>,
        label: String = "6-digit authentication code",
        isError: Bool = false,
        identifier: String,
        autoFocus: Bool = false,
        onComplete: (() -> Void)? = nil
    ) {
        self._code = code
        self.label = label
        self.isError = isError
        self.identifier = identifier
        self.autoFocus = autoFocus
        self.onComplete = onComplete
    }

    /// Digits only, at most six (pure; unit-tested).
    static func sanitised(_ raw: String) -> String {
        String(raw.filter { ("0"..."9").contains($0) }.prefix(length))
    }

    private var digits: [Character] { Array(code) }

    private var spokenValue: String {
        code.isEmpty ? "Empty" : code.map(String.init).joined(separator: " ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .scheduleType(SecurityType.label)
                .accessibilityHidden(true)
            ZStack {
                HStack(spacing: 8) {
                    ForEach(0..<Self.length, id: \.self) { index in
                        box(at: index)
                    }
                }
                .accessibilityHidden(true)

                TextField("", text: $code)
                    .textContentType(.oneTimeCode)
                    .keyboardType(.numberPad)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .focused($focused)
                    // The real field is invisible: the boxes draw its text.
                    .foregroundStyle(Color.clear)
                    .tint(Color.clear)
                    .frame(maxWidth: .infinity, minHeight: SecurityTokens.fieldHeight)
                    .contentShape(Rectangle())
                    .accessibilityLabel(label)
                    .accessibilityValue(spokenValue)
                    .accessibilityHint(isError ? "The last code didn’t work." : "")
                    .accessibilityIdentifier(identifier)
            }
            // A tap anywhere on the six boxes focuses the one real field. Without this, a tap that lands on the
            // field's empty, invisible text area did not always take focus (ci-iphone: "Neither element nor any
            // descendant has keyboard focus" when moving here from the password field).
            .contentShape(Rectangle())
            .simultaneousGesture(TapGesture().onEnded { focused = true })
        }
        .onChange(of: code) { newValue in
            let clean = Self.sanitised(newValue)
            if clean != newValue {
                code = clean
                return
            }
            if clean.count == Self.length { onComplete?() }
        }
        .task { @MainActor in
            guard autoFocus else { return }
            // Let the screen finish appearing before the keyboard rises.
            try? await Task.sleep(nanoseconds: 350_000_000)
            focused = true
        }
    }

    @ViewBuilder
    private func box(at index: Int) -> some View {
        let filled = index < digits.count
        let active = focused && index == min(digits.count, Self.length - 1) && !isError
        Text(filled ? String(digits[index]) : "–")
            .font(.system(size: 21, weight: .medium).monospacedDigit())
            .foregroundStyle(filled ? (isError ? SecurityTokens.red : SecurityTokens.ink) : SecurityTokens.emptyDigit)
            .frame(maxWidth: .infinity, minHeight: SecurityTokens.fieldHeight)
            .background(RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous).fill(SecurityTokens.surface))
            .overlay(
                RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous)
                    .stroke(isError ? SecurityTokens.red : (active ? SecurityTokens.action : SecurityTokens.line), lineWidth: active ? 1.5 : 1)
            )
    }
}
