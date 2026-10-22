import SwiftUI

/// The ONE Users page of the Venue Manager app (Flutter `VenueUsersScreen`):
/// only Staff the Initial Manager assigned to this Venue Manager
/// (`GET /staff/venue-directory`). No discovery pool, no invitations, no
/// org-wide users, and the VM can never add or remove team members. "Edit"
/// = select several → Send Offer (only with `staffing_request.create`).
/// Opened from Send Shift it is the staff picker and returns the selection.
struct VMUsersScreen: View {
    enum Mode {
        case browse
        case picker(initial: [DirectoryUser], startAt: Date, endAt: Date, excludeShiftId: String?, onDone: ([DirectoryUser]) -> Void)
    }

    let mode: Mode

    @EnvironmentObject private var store: VenueManagerStore
    @EnvironmentObject private var toasts: ToastCenter
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @State private var users: [DirectoryUser] = []
    @State private var page = 1
    @State private var total = 0
    @State private var loading = true
    @State private var loadError: Error?
    @State private var status: String?
    @State private var tag: String?
    @State private var selected: [DirectoryUser] = []
    @State private var selecting = false
    @State private var generation = 0
    @State private var showsFilters = false
    @State private var profile: DirectoryUser?
    @State private var sendStaff: [DirectoryUser]?
    @State private var started = false

    private var isPicker: Bool {
        if case .picker = mode { return true }
        return false
    }

    private var canSend: Bool { store.allows(.staffingRequestCreate) }

    var body: some View {
        VMPage(title: "Users", trailing: {
            if selecting {
                VMPillButton(title: "Done") { done() }.accessibilityIdentifier("vm.users.done")
            } else if canSend && store.allows(.staffView) {
                VMPillButton(title: "Edit") { selecting = true }.accessibilityIdentifier("vm.users.edit")
            }
        }) {
            VStack(alignment: .leading, spacing: 10) {
                if selecting {
                    Text("\(selected.count) selected").scheduleType(ScheduleType.caption).padding(.horizontal, 16)
                }
                searchBar
                chips
                content
            }
        }
        .safeAreaInset(edge: .bottom) {
            if selecting {
                BottomAction {
                    PrimaryButton(isPicker ? "Done" : "Send Offer", systemImage: isPicker ? "checkmark" : "paperplane.fill", background: VMColor.navy) {
                        if isPicker { done() } else { sendStaff = selected }
                    }
                    .disabled(selected.isEmpty || (!isPicker && !canSend))
                    .accessibilityIdentifier("vm.users.sendOffer")
                }
                .background(ScheduleTokens.homeBackground.ignoresSafeArea())
            }
        }
        .confirmationDialog("Employment status", isPresented: $showsFilters, titleVisibility: .visible) {
            ForEach(VMDirectory.employmentFilters, id: \.self) { filter in
                Button(filter.label + (status == filter.key ? " ✓" : "")) {
                    status = filter.key
                    Task { await load() }
                }
            }
        }
        .task {
            if case .picker(let initial, _, _, _, _) = mode, !started { selected = initial; selecting = true }
            guard !started else { return }
            started = true
            await load()
        }
        .onChange(of: search) { _ in
            Task { await debouncedLoad() }
        }
        .vmDestination($profile) { user in
            VMStaffProfileView(
                user: user,
                selectionContext: selecting,
                onChanged: { next in apply(next) },
                onGone: { gone(user.id, announce: false) },
                onSelect: { if !selected.contains(where: { $0.id == user.id }) { toggle(user) } }
            )
        }
        .vmDestination($sendStaff) { staff in
            VMSendShiftView(initialStaff: staff) {
                selected = []
                selecting = false
            }
        }
        .accessibilityIdentifier("vm.users")
    }

    // MARK: Pieces

    private var searchBar: some View {
        HStack(spacing: 10) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass").foregroundStyle(ScheduleTokens.muted).accessibilityHidden(true)
                TextField("Search staff…", text: $search)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .submitLabel(.search)
                    .accessibilityIdentifier("vm.users.search")
            }
            .padding(.horizontal, 14)
            .frame(minHeight: 44)
            .background(Capsule().fill(Color.white))
            .overlay(Capsule().stroke(VMColor.rowBorder, lineWidth: 1))
            VMCircleButton(systemImage: "slider.horizontal.3", label: "Filter users", foreground: VMColor.navy, showsDot: status != nil) {
                showsFilters = true
            }
        }
        .padding(.horizontal, 16)
    }

    private var chips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(VMDirectory.tagChips, id: \.self) { chip in
                    VMChip(label: chip.label, selected: tag == chip.key) { setTag(chip.key) }
                        .accessibilityIdentifier("vm.users.chip.\(chip.key ?? "all")")
                }
                if let status {
                    VMChip(label: VMDirectory.employmentLabel(status) ?? status, selected: false, removable: true) {
                        self.status = nil
                        Task { await load() }
                    }
                }
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private var content: some View {
        if let error = store.error {
            VMLoadFailure(message: error) { Task { await store.refresh() } }
        } else if !store.loading && !store.allows(.staffView) {
            MessageCard(title: "Staff viewing is not permitted.", kind: .error).padding(ScheduleTokens.homeInset)
        } else if let loadError {
            if (loadError as? APIError)?.statusCode == 403 {
                MessageCard(title: "You do not have permission to view staff.", kind: .error).padding(ScheduleTokens.homeInset)
            } else {
                VMLoadFailure(message: "Unable to load staff. Please try again.") { Task { await load() } }
            }
        } else if (loading && users.isEmpty) || (store.loading && store.updatedAt == nil) {
            VMInlineLoading(label: "Loading staff")
            Spacer()
        } else {
            list
        }
    }

    private var list: some View {
        let filtered = !search.trimmingCharacters(in: .whitespaces).isEmpty || status != nil
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Staff").scheduleType(ScheduleType.cardTitle).accessibilityAddTraits(.isHeader)
                    Spacer()
                    Text("\(total) \(VMText.plural(total, "member", "members"))").scheduleType(ScheduleType.caption)
                        .accessibilityIdentifier("vm.users.count")
                }
                .padding(.bottom, 4)
                if users.isEmpty {
                    VStack(spacing: 6) {
                        Text(VMDirectory.emptyTitle(filtered: filtered, tag: tag)).scheduleType(ScheduleType.bodyStrong)
                        if !filtered && tag == nil {
                            Text("Your manager assigns staff to you").scheduleType(ScheduleType.caption)
                        }
                    }
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 32)
                }
                ForEach(users) { user in row(user) }
                if users.count < total {
                    Button(loading ? "Loading…" : "Load more") { Task { await load(more: true) } }
                        .disabled(loading)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
            }
            .padding(EdgeInsets(top: 4, leading: 16, bottom: 24, trailing: 16))
        }
        .refreshable { await load() }
    }

    private func row(_ user: DirectoryUser) -> some View {
        let isSelected = selected.contains { $0.id == user.id }
        return Button {
            if selecting { toggle(user) } else { profile = user }
        } label: {
            VMStaffRow(name: user.name, role: user.jobRoleName, leading: {
                if selecting { VMSquareCheck(checked: isSelected) }
            }, suffix: {
                if user.isFavourite {
                    Image(systemName: "heart.fill").font(.system(size: 13)).foregroundStyle(VMColor.favourite).accessibilityLabel("Favourite")
                }
                if user.isEmergency {
                    Image(systemName: "exclamationmark.triangle").font(.system(size: 13)).foregroundStyle(VMColor.emergency).accessibilityLabel("Emergency cover")
                }
            }, trailing: {
                // Only a server-evaluated window yields a badge; unknown shows none.
                if let available = user.available { VMAvailabilityBadge(available: available) }
            })
        }
        .buttonStyle(PressableButtonStyle())
        .accessibilityAddTraits(selecting && isSelected ? .isSelected : [])
        .accessibilityIdentifier("vm.users.row.\(user.id)")
        .contextMenu { quickActions(user) }
        .accessibilityAction(named: user.isFavourite ? "Remove from favourite" : "Add to favourite") { Task { await setTags(user, favourite: !user.isFavourite) } }
        .accessibilityAction(named: user.isEmergency ? "Remove from emergency" : "Add to emergency") { Task { await setTags(user, emergency: !user.isEmergency) } }
        .accessibilityAction(named: "View profile") { profile = user }
    }

    /// Long-press actions (Flutter quick actions). Never offers removal.
    @ViewBuilder
    private func quickActions(_ user: DirectoryUser) -> some View {
        Button { Task { await setTags(user, favourite: !user.isFavourite) } } label: {
            Label(user.isFavourite ? "Remove from favourite" : "Add to favourite", systemImage: user.isFavourite ? "heart.fill" : "heart")
        }
        Button { Task { await setTags(user, emergency: !user.isEmergency) } } label: {
            Label(user.isEmergency ? "Remove from emergency" : "Add to emergency", systemImage: "exclamationmark.triangle")
        }
        if isPicker {
            Button { toggle(user) } label: {
                Label(selected.contains { $0.id == user.id } ? "Remove from selection" : "Select staff", systemImage: "checkmark.square")
            }
        } else if canSend {
            Button { sendStaff = [user] } label: { Label("Send offer", systemImage: "paperplane") }
        }
        Button { profile = user } label: { Label("View profile", systemImage: "person") }
    }

    // MARK: Actions

    private func done() {
        if case .picker(_, _, _, _, let onDone) = mode {
            onDone(selected)
            dismiss()
        } else {
            selecting = false
            selected = []
        }
    }

    private func toggle(_ user: DirectoryUser) {
        // A client-side UX guard only — never the authorisation boundary.
        if let index = selected.firstIndex(where: { $0.id == user.id }) {
            selected.remove(at: index)
        } else if selected.count < VMDirectory.selectionLimit {
            selected.append(user)
        }
    }

    private func setTag(_ next: String?) {
        guard tag != next else { return }
        tag = next
        Task { await load() }
    }

    private func apply(_ next: DirectoryUser) {
        let result = VMDirectory.replacing(users, total: total, with: next, tag: tag)
        users = result.users
        total = result.total
        if let index = selected.firstIndex(where: { $0.id == next.id }) { selected[index] = next }
    }

    /// 404 for someone listed: the assignment ended. Drop them and reload.
    private func gone(_ id: String, announce: Bool = true) {
        selected.removeAll { $0.id == id }
        if announce { toasts.show(VMDirectory.notAssignedMessage, kind: .error) }
        Task { await load() }
    }

    @MainActor
    private func setTags(_ user: DirectoryUser, favourite: Bool? = nil, emergency: Bool? = nil) async {
        do {
            let tags = try await store.repository.setTags(user.id, favourite: favourite, emergency: emergency)
            apply((users.first { $0.id == user.id } ?? user).withTags(tags))
        } catch {
            if VMDirectory.isNotAssigned(error) {
                gone(user.id)
            } else if (error as? APIError)?.isUncertainOutcome == true {
                // The tag may have changed: show the server's state, never resend.
                await load()
                toasts.showError(error)
            } else {
                toasts.show(VMDirectory.errorMessage(error, viewing: false), kind: .error)
            }
        }
    }

    @MainActor
    private func debouncedLoad() async {
        generation += 1
        let stamp = generation
        try? await Task.sleep(nanoseconds: 300_000_000)
        guard stamp == generation else { return }
        await load()
    }

    @MainActor
    private func load(more: Bool = false) async {
        generation += 1
        let stamp = generation
        loading = true
        loadError = nil
        if !more {
            page = 1
            users = []
        }
        // From My Space there is no shift in mind: ask for a real "busy right
        // now" signal (now → now + 1 min), exactly like Flutter.
        let window: (Date, Date, String?)
        if case .picker(_, let start, let end, let exclude, _) = mode {
            window = (start, end, exclude)
        } else {
            let now = Date()
            window = (now, now.addingTimeInterval(60), nil)
        }
        do {
            let result = try await store.repository.directory(query: search, page: more ? page + 1 : 1, status: status, tag: tag,
                                                              startAt: window.0, endAt: window.1, excludeShiftId: window.2)
            guard stamp == generation else { return }
            users = more ? users + result.data.filter { row in !users.contains { $0.id == row.id } } : result.data
            total = result.total
            if more { page += 1 }
            loading = false
        } catch {
            guard stamp == generation else { return }
            loading = false
            let api = error as? APIError
            if api != .cancelled, api != .sessionChanged { loadError = error }
        }
    }
}

struct VMAvailabilityBadge: View {
    let available: Bool

    var body: some View {
        VMPill(available ? "Available" : "Not Available",
               background: available ? RGBA(argb: 0xFFE7F6EC).color : RGBA(argb: 0xFFFDECEC).color,
               foreground: available ? RGBA(argb: 0xFF1F8A4C).color : RGBA(argb: 0xFFC0392B).color)
    }
}

struct VMSquareCheck: View {
    let checked: Bool

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 6, style: .continuous).fill(checked ? VMColor.navy : .white)
            RoundedRectangle(cornerRadius: 6, style: .continuous).stroke(checked ? VMColor.navy : RGBA(argb: 0xFFC7CBD1).color, lineWidth: 1.6)
            if checked { Image(systemName: "checkmark").font(.system(size: 12, weight: .bold)).foregroundStyle(.white) }
        }
        .frame(width: 22, height: 22)
        .accessibilityHidden(true)
    }
}
