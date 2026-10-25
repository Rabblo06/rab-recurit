import SwiftUI
import UIKit

/// Shared frame for the sign-in family of screens: scrollable, centred,
/// capped width, keyboard-safe.
struct AuthScaffold<Content: View>: View {
    private let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text("Crewflow")
                    .scheduleType(ScheduleType.overline)
                    .accessibilityHidden(true)
                content
            }
            .frame(maxWidth: 440)
            .padding(.horizontal, ScheduleTokens.homeInset)
            .padding(.vertical, 32)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.interactively)
        .background(ScheduleTokens.homeBackground.ignoresSafeArea())
    }
}

/// Uppercase label + rounded field (Flutter login field style).
struct AuthField<Field: View>: View {
    private let label: String
    private let field: Field

    init(_ label: String, @ViewBuilder field: () -> Field) {
        self.label = label
        self.field = field()
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(label)
                .scheduleType(ScheduleType.overline)
                .accessibilityHidden(true)
            field
                .scheduleType(ScheduleType.body)
                .padding(.horizontal, 14)
                .frame(minHeight: 52)
                .background(
                    RoundedRectangle(cornerRadius: ScheduleTokens.fieldRadius, style: .continuous)
                        .fill(Color.white)
                )
                .overlay(
                    RoundedRectangle(cornerRadius: ScheduleTokens.fieldRadius, style: .continuous)
                        .stroke(ScheduleTokens.border, lineWidth: 1)
                )
        }
    }
}

/// Password entry with a Show/Hide control. Never logged, never persisted.
struct PasswordField: View {
    let placeholder: String
    @Binding var text: String
    var contentType: UITextContentType = .password
    var identifier: String
    var submitLabel: SubmitLabel = .return
    var onSubmit: (() -> Void)?
    @State private var revealed = false

    init(
        placeholder: String,
        text: Binding<String>,
        contentType: UITextContentType = .password,
        identifier: String,
        submitLabel: SubmitLabel = .return,
        onSubmit: (() -> Void)? = nil
    ) {
        self.placeholder = placeholder
        self._text = text
        self.contentType = contentType
        self.identifier = identifier
        self.submitLabel = submitLabel
        self.onSubmit = onSubmit
    }

    var body: some View {
        HStack(spacing: 8) {
            Group {
                if revealed {
                    TextField(placeholder, text: $text)
                } else {
                    SecureField(placeholder, text: $text)
                }
            }
            .textContentType(contentType)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .submitLabel(submitLabel)
            .onSubmit { onSubmit?() }
            .accessibilityLabel(placeholder)
            .accessibilityIdentifier(identifier)
            Button(revealed ? "Hide" : "Show") { revealed.toggle() }
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(ScheduleTokens.ink)
                .frame(minWidth: ScheduleTokens.touchTarget, minHeight: ScheduleTokens.touchTarget)
                .accessibilityLabel(revealed ? "Hide password" : "Show password")
        }
    }
}

/// Inline banner (reauth reason, session expiry). Not a toast: it explains
/// why the person is on this screen and stays until they sign in.
struct AuthBanner: View {
    let text: String
    var systemImage = "lock.shield"

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: systemImage)
                .foregroundStyle(ScheduleTokens.muted)
                .accessibilityHidden(true)
            Text(text).scheduleType(ScheduleType.secondary.colored(ScheduleTokens.ink))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: ScheduleTokens.fieldRadius, style: .continuous).fill(Color.white))
        .accessibilityElement(children: .combine)
    }
}

/// Inline form error (stays until the next attempt).
struct InlineError: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "exclamationmark.circle")
                .accessibilityHidden(true)
            Text(text)
        }
        .scheduleType(ScheduleType.secondary.colored(ScheduleTokens.errorText))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Error. \(text)")
        .accessibilityIdentifier("auth.error")
    }
}

extension String {
    var trimmed: String { trimmingCharacters(in: .whitespacesAndNewlines) }
}
