import SwiftUI

/// `codeList()`: the recovery codes in tabular monospace, two columns when
/// they fit and one column otherwise (19-character codes overflow two
/// columns on a 375 pt phone or with large Dynamic Type; UI_PLAN §7 #7).
struct RecoveryCodeGrid: View {
    let codes: [String]

    init(codes: [String]) {
        self.codes = codes
    }

    private var half: Int { (codes.count + 1) / 2 }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .top, spacing: 16) {
                column(Array(codes.prefix(half)), offset: 0)
                column(Array(codes.dropFirst(half)), offset: half)
            }
            column(codes, offset: 0)
        }
        .padding(.vertical, 20)
        .padding(.horizontal, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(SecurityTokens.surface))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(SecurityTokens.cardLine, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Recovery codes")
        .accessibilityIdentifier("security.recoveryCodes")
    }

    private func column(_ items: [String], offset: Int) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            ForEach(Array(items.enumerated()), id: \.offset) { index, code in
                Text(code)
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .tracking(0.4)
                    .foregroundStyle(SecurityTokens.ink)
                    .lineLimit(1)
                    .fixedSize()
                    .accessibilityLabel(Text("Code \(offset + index + 1), ") + Text(code).speechSpellsOutCharacters())
            }
        }
    }

    /// The text that Share / Copy hand over. No secret beyond the codes.
    static func shareText(codes: [String], email: String?) -> String {
        var lines = ["Crewflow recovery codes"]
        if let email, !email.isEmpty { lines.append("Account: \(email)") }
        lines.append("Each code works once. Keep them somewhere safe.")
        lines.append("")
        lines.append(contentsOf: codes)
        return lines.joined(separator: "\n")
    }
}

/// `keyBox()`: the manual setup key with a copy control. Copy strips the
/// display spaces; the pasteboard copy stays on this device and expires.
struct SetupKeyBox: View {
    let key: String
    @State private var copied = false

    init(key: String) {
        self.key = key
    }

    static func copyValue(_ key: String) -> String {
        key.filter { !$0.isWhitespace }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Setup key")
                .scheduleType(SecurityType.label)
                .accessibilityHidden(true)
            HStack(alignment: .center, spacing: 10) {
                Text(key)
                    .font(.system(size: 13, weight: .medium, design: .monospaced))
                    .tracking(0.25)
                    .foregroundStyle(SecurityTokens.ink)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityLabel(Text("Setup key, ") + Text(Self.copyValue(key)).speechSpellsOutCharacters())
                Button {
                    SecurePasteboard.copy(Self.copyValue(key))
                    copied = true
                    SecurityNotice.announce("Setup key copied")
                } label: {
                    Image(systemName: copied ? "checkmark" : "doc.on.doc")
                        .font(.system(size: 15, weight: .medium))
                        .foregroundStyle(SecurityTokens.ink)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(PressableButtonStyle())
                .accessibilityLabel(copied ? "Setup key copied" : "Copy setup key")
                .accessibilityIdentifier("setup.copyKey")
            }
            .padding(.leading, 14)
            .padding(.trailing, 4)
            .padding(.vertical, 4)
            .background(RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous).fill(SecurityTokens.surface))
            .overlay(RoundedRectangle(cornerRadius: SecurityTokens.fieldRadius, style: .continuous).stroke(SecurityTokens.line, lineWidth: 1))
            if copied {
                Text("Copied. It stays on this iPhone and clears from the clipboard after \(Int(SecurePasteboard.lifetime / 60)) minutes.")
                    .scheduleType(SecurityType.caption)
            }
        }
    }
}
