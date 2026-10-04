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

    private var question: TranscriptEvent? {
        store.pendingQuestion(in: sessionId)
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    header

                    if let approval {
                        ApprovalCard(event: approval, sessionId: sessionId)
                    }
                    if let question {
                        QuestionCard(event: question, sessionId: sessionId)
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
/// ZCode sends the exact options for each request (e.g. "Allow once",
/// "Allow always", "Deny"), so those become the buttons.
struct ApprovalCard: View {
    let event: TranscriptEvent
    let sessionId: String

    @EnvironmentObject private var store: SessionStore

    private var options: [PermissionOption] { event.options ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "hand.raised.fill").foregroundStyle(.orange)
                Text("Permission needed").font(.system(size: 13, weight: .bold))
                Spacer()
                if let risk = event.riskLevel, !risk.isEmpty {
                    Text(risk)
                        .font(.system(size: 9, weight: .bold))
                        .padding(.horizontal, 5).padding(.vertical, 1)
                        .background(Capsule().fill(riskColor(risk).opacity(0.25)))
                        .foregroundStyle(riskColor(risk))
                }
            }
            Text(event.tool ?? "tool")
                .font(.system(size: 13, weight: .semibold))
            if !detailText.isEmpty {
                Text(detailText)
                    .font(.system(size: 11))
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
            }

            if options.isEmpty {
                HStack(spacing: 6) {
                    decisionButton(title: "Allow", symbol: "checkmark", allow: true, tint: .green, optionId: nil)
                    decisionButton(title: "Deny", symbol: "xmark", allow: false, tint: .red, optionId: nil)
                }
            } else {
                ForEach(options) { option in
                    Button {
                        store.respond(
                            allow: isAllow(option),
                            sessionId: sessionId,
                            requestId: event.requestId ?? "",
                            optionId: option.id
                        )
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.name.isEmpty ? option.id : option.name)
                                .font(.system(size: 13, weight: .semibold))
                            if !option.description.isEmpty {
                                Text(option.description)
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .tint(isAllow(option) ? .green : .red)
                }
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(.orange.opacity(0.15)))
    }

    private func decisionButton(title: String, symbol: String, allow: Bool, tint: Color, optionId: String?) -> some View {
        Button {
            store.respond(allow: allow, sessionId: sessionId, requestId: event.requestId ?? "", optionId: optionId)
        } label: {
            Label(title, systemImage: symbol).frame(maxWidth: .infinity)
        }
        .buttonStyle(.borderedProminent)
        .tint(tint)
    }

    private func isAllow(_ option: PermissionOption) -> Bool {
        let id = option.id.lowercased()
        if id.contains("deny") || id.contains("reject") || id.contains("cancel") { return false }
        return id.contains("allow") || id.contains("accept") || id.contains("approve") || id.contains("yes")
    }

    private var detailText: String {
        if let s = event.summary, !s.isEmpty { return s }
        return event.detail ?? ""
    }

    private func riskColor(_ risk: String) -> Color {
        switch risk.lowercased() {
        case "critical", "high": return .red
        case "medium": return .orange
        default: return .green
        }
    }
}

/// The agent asked a question (AskUserQuestion). Answer with a tap, or type
/// something of your own.
struct QuestionCard: View {
    let event: TranscriptEvent
    let sessionId: String

    @EnvironmentObject private var store: SessionStore
    @State private var typed: String = ""

    private var questions: [PendingQuestion] { event.questions ?? [] }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Image(systemName: "questionmark.bubble.fill").foregroundStyle(.blue)
                Text("Question").font(.system(size: 13, weight: .bold))
            }
            if !(event.prompt ?? "").isEmpty {
                Text(event.prompt ?? "")
                    .font(.system(size: 12))
                    .lineLimit(4)
            }

            ForEach(Array(questions.enumerated()), id: \.offset) { _, q in
                if !q.question.isEmpty {
                    Text(q.question)
                        .font(.system(size: 12, weight: .semibold))
                }
                ForEach(Array(q.options.enumerated()), id: \.offset) { _, option in
                    Button {
                        store.answer(option.label, sessionId: sessionId, requestId: event.requestId ?? "")
                    } label: {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(option.label).font(.system(size: 13, weight: .semibold))
                            if !option.description.isEmpty {
                                Text(option.description)
                                    .font(.system(size: 10))
                                    .foregroundStyle(.secondary)
                                    .lineLimit(2)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .buttonStyle(.bordered)
                    .tint(.blue)
                }
            }

            HStack(spacing: 6) {
                TextField("Your answer", text: $typed)
                Button {
                    let value = typed
                    typed = ""
                    store.answer(value, sessionId: sessionId, requestId: event.requestId ?? "")
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                }
                .buttonStyle(.plain)
                .disabled(typed.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            Button("Dismiss") {
                store.dismissQuestion(sessionId: sessionId, requestId: event.requestId ?? "")
            }
            .font(.system(size: 11))
            .foregroundStyle(.secondary)
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(.blue.opacity(0.15)))
    }
}

struct ModePickerView: View {
    let sessionId: String
    let current: String

    @EnvironmentObject private var store: SessionStore
    @Environment(\.dismiss) private var dismiss

    private let modes = ["plan", "build", "edit", "yolo", "auto"]

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
                Text("plan: read-only · build: ask first · edit: auto-apply · yolo: never ask · auto: server decides")
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
