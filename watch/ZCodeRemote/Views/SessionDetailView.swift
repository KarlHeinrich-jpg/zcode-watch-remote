import SwiftUI

struct SessionDetailView: View {
    let sessionId: String

    @EnvironmentObject private var store: SessionStore
    @State private var input: String = ""
    @State private var showingModePicker = false

    private var session: SessionSummary? {
        store.sessions.first { $0.id == sessionId }
    }

    private var events: [TranscriptEvent] {
        store.transcript(for: sessionId)
    }

    private var approval: TranscriptEvent? {
        store.pendingApproval(in: sessionId)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    header

                    if let approval {
                        ApprovalCard(event: approval, sessionId: sessionId)
                    }

                    ForEach(events) { event in
                        EventRowView(event: event)
                            .id(event.id)
                    }

                    if events.isEmpty {
                        Text("Say something to get started.")
                            .font(.system(size: 12))
                            .foregroundStyle(.secondary)
                    }
                }
                .padding(.horizontal, 2)
            }
            .onChange(of: events.count) {
                if let last = events.last {
                    withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            inputBar
        }
        .navigationTitle(session?.projectName ?? "Session")
        .sheet(isPresented: $showingModePicker) {
            ModePickerView(sessionId: sessionId, current: session?.mode ?? "")
        }
    }

    private var header: some View {
        HStack(spacing: 6) {
            StatusBadge(status: session?.status ?? "idle", waiting: approval != nil)
            Spacer()
            if session?.isRunning == true {
                Button {
                    store.interrupt(sessionId)
                } label: {
                    Image(systemName: "stop.circle.fill")
                        .foregroundStyle(.red)
                }
                .buttonStyle(.plain)
            }
            Button {
                showingModePicker = true
            } label: {
                Image(systemName: "slider.horizontal.3")
            }
            .buttonStyle(.plain)
        }
    }

    private var inputBar: some View {
        HStack(spacing: 6) {
            TextField("Message", text: $input)
                .textInputAutocapitalization(.sentences)
            Button {
                let text = input
                input = ""
                store.sendPrompt(text, to: sessionId)
                Haptics.tap()
            } label: {
                Image(systemName: "arrow.up.circle.fill")
                    .font(.title3)
            }
            .buttonStyle(.plain)
            .disabled(input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 8)
        .background(.ultraThinMaterial)
    }
}

/// Prominent allow/deny card — the reason this app exists.
struct ApprovalCard: View {
    let event: TranscriptEvent
    let sessionId: String

    @EnvironmentObject private var store: SessionStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("Permission needed").font(.system(size: 13, weight: .bold))
            }
            Text(event.tool ?? "tool")
                .font(.system(size: 13, weight: .semibold))
            if let summary = event.detail ?? event.message, !summary.isEmpty {
                Text(summary)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }
            HStack(spacing: 6) {
                Button {
                    store.respond(allow: true, sessionId: sessionId, requestId: event.requestId ?? "")
                } label: {
                    Label("Allow", systemImage: "checkmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)

                Button {
                    store.respond(allow: false, sessionId: sessionId, requestId: event.requestId ?? "")
                } label: {
                    Label("Deny", systemImage: "xmark").frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .tint(.red)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.15)))
    }
}

struct ModePickerView: View {
    let sessionId: String
    let current: String

    @EnvironmentObject private var store: SessionStore
    @Environment(\.dismiss) private var dismiss

    private let modes = ["plan", "build", "edit", "yolo"]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 6) {
                Text("Permission mode").font(.headline)
                ForEach(modes, id: \.self) { mode in
                    Button {
                        store.setMode(mode, sessionId: sessionId)
                        dismiss()
                    } label: {
                        HStack {
                            Text(modeLabel(mode))
                            Spacer()
                            if mode == current { Image(systemName: "checkmark") }
                        }
                    }
                    .buttonStyle(.plain)
                }
                Text("plan: read-only · build: ask before changes · edit: auto-apply edits · yolo: no prompts")
                    .font(.system(size: 10))
                    .foregroundStyle(.secondary)
            }
            .padding(.horizontal, 2)
        }
    }

    private func modeLabel(_ mode: String) -> String {
        mode.prefix(1).uppercased() + mode.dropFirst()
    }
}
