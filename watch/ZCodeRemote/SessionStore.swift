import Foundation
import SwiftUI

/// App-wide state: connection, session list, transcripts and approvals.
@MainActor
final class SessionStore: ObservableObject {
    @Published var sessions: [SessionSummary] = []
    @Published var projects: [ProjectRef] = []
    @Published var transcripts: [String: [TranscriptEvent]] = [:]
    @Published var connection: BridgeClient.State = .idle
    @Published var banner: String?
    @Published var lastError: String?
    /// sessionIds that produced new output since the user last looked at them
    @Published var unread: Set<String> = []

    let settings: BridgeSettings
    private let client = BridgeClient()
    private var currentSessionId: String?

    init(settings: BridgeSettings) {
        self.settings = settings
        client.onStateChange = { [weak self] state in
            Task { @MainActor in
                guard let self else { return }
                self.connection = state
                guard case .connected = state else { return }
                if self.pendingPair != nil {
                    self.flushPendingPair()
                } else if self.settings.isPaired {
                    // Re-authenticate on every (re)connect.
                    self.client.send(.hello(token: self.settings.token,
                                            device: self.settings.deviceName))
                }
            }
        }
        client.onMessage = { [weak self] message in
            Task { @MainActor in self?.handle(message) }
        }
    }

    // MARK: - Connection

    var isConnected: Bool {
        if case .connected = connection { return true }
        return false
    }

    func connectIfPossible() {
        guard settings.isPaired, let url = BridgeSettings.websocketURL(from: settings.host) else { return }
        client.connect(to: url)
    }

    func disconnect() {
        client.disconnect()
    }

    /// Pair with a PIN; on success the bridge returns a token we store.
    func pair(hostInput: String, pin: String) {
        guard let url = BridgeSettings.websocketURL(from: hostInput) else {
            lastError = "Address looks wrong. Example: 192.168.1.5:8788"
            return
        }
        settings.host = hostInput.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = nil
        settings.token = ""   // force the pair path
        client.connect(to: url)
        // The pair message is sent once the socket opens — see retryPair below.
        pendingPair = (pin, settings.deviceName)
    }

    private var pendingPair: (pin: String, device: String)?

    private func flushPendingPair() {
        guard let p = pendingPair else { return }
        pendingPair = nil
        client.send(.pair(pin: p.pin, device: p.device))
    }

    func unpair() {
        client.disconnect()
        settings.unpair()
        sessions = []
        transcripts = [:]
        projects = []
        unread = []
    }

    // MARK: - Incoming

    private func handle(_ message: BridgeMessage) {
        switch message {
        case .paired(let token, let name, let projects, let sessions):
            pendingPair = nil
            settings.save(host: settings.host, token: token, bridgeName: name)
            self.projects = projects
            self.sessions = sessions
            banner = "Connected to \(name)"
            Haptics.turnFinished(success: true)

        case .welcome(let name, let projects, let sessions):
            self.projects = projects
            self.sessions = sessions
            if settings.bridgeName != name { settings.bridgeName = name }

        case .sessions(let sessions):
            self.sessions = sessions

        case .sessionCreated(let id):
            unread.insert(id)
            Haptics.tap()

        case .sessionState(let id, let status, let events):
            if events.isEmpty {
                transcripts[id] = transcripts[id] ?? []
            } else {
                transcripts[id] = events
            }
            if var s = sessions.first(where: { $0.id == id }) {
                s.status = status
                if let i = sessions.firstIndex(where: { $0.id == id }) { sessions[i] = s }
            }
            unread.remove(id)

        case .sessionEvent(let id, let event):
            append(event, to: id)
            if currentSessionId != id {
                unread.insert(id)
            }
            react(to: event, in: id)

        case .promptAccepted:
            Haptics.tap()

        case .permissionAccepted:
            Haptics.turnFinished(success: true)

        case .inputAccepted:
            Haptics.tap()

        case .externalEvent(let event, let message, let project):
            banner = "\(project.isEmpty ? "" : project + ": ")\(message.isEmpty ? event : message)"
            Haptics.hookNotice()

        case .pong:
            break

        case .bridgeError(let code, let message):
            lastError = message
            if code == "unauthorized" || code == "bad-token" {
                settings.token = ""
            }
            Haptics.turnFinished(success: false)

        case .unknown(let type):
            print("ZCodeRemote: unhandled bridge message '\(type)'")
        }
    }

    /// Add an event, honouring the bridge's streaming/replacement semantics:
    /// `streaming` events grow one bubble, `replace` events swap the card that
    /// was created earlier for the same request id.
    private func append(_ event: TranscriptEvent, to sessionId: String) {
        var list = transcripts[sessionId] ?? []

        if event.replace == true, let requestId = event.requestId,
           let idx = list.lastIndex(where: { $0.requestId == requestId && $0.kind == event.kind }) {
            list[idx] = event
        } else if event.streaming == true, let last = list.last, last.streaming == true, last.kind == event.kind {
            list[list.count - 1] = event
        } else {
            list.append(event)
        }

        if list.count > 200 { list.removeFirst(list.count - 200) }
        transcripts[sessionId] = list
    }

    private func react(to event: TranscriptEvent, in sessionId: String) {
        switch event.kind {
        case "permission":
            Haptics.approvalNeeded()
            banner = "Approval needed: \(event.tool ?? "tool")"
        case "question":
            Haptics.approvalNeeded()
            banner = "The agent has a question"
        case "result":
            Haptics.turnFinished(success: event.isError != true)
        case "error":
            Haptics.turnFinished(success: false)
            lastError = event.message
        default:
            break
        }
    }

    // MARK: - Outgoing

    func refreshSessions() {
        client.send(.sessionsList)
    }

    func openSession(_ id: String) {
        currentSessionId = id
        unread.remove(id)
        client.send(.sessionOpen(sessionId: id))
    }

    func closeSessionView() {
        currentSessionId = nil
    }

    func sendPrompt(_ text: String, to sessionId: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        client.send(.prompt(sessionId: sessionId, text: trimmed))
    }

    func interrupt(_ sessionId: String) {
        client.send(.interrupt(sessionId: sessionId))
        Haptics.tap()
    }

    func respond(allow: Bool, sessionId: String, requestId: String, optionId: String? = nil) {
        client.send(.permissionResponse(sessionId: sessionId, requestId: requestId, allow: allow, optionId: optionId))
        Haptics.turnFinished(success: allow)
    }

    /// Answer an AskUserQuestion prompt (choice label or free text).
    func answer(_ text: String, sessionId: String, requestId: String) {
        client.send(.answerInput(sessionId: sessionId, requestId: requestId, text: text, cancelled: false))
        Haptics.tap()
    }

    func dismissQuestion(sessionId: String, requestId: String) {
        client.send(.answerInput(sessionId: sessionId, requestId: requestId, text: nil, cancelled: true))
        Haptics.tap()
    }

    func setMode(_ mode: String, sessionId: String) {
        client.send(.setMode(sessionId: sessionId, mode: mode))
    }

    func newSession(in projectPath: String) {
        client.send(.newSession(projectPath: projectPath))
    }

    func transcript(for id: String) -> [TranscriptEvent] {
        transcripts[id] ?? []
    }

    /// The newest unanswered approval request in a session, if any.
    func pendingApproval(in sessionId: String) -> TranscriptEvent? {
        guard let event = lastUnanswered(kind: "permission", in: sessionId) else { return nil }
        // Cards produced only by the event stream (no actionable request) are
        // informational; the bridge sets `historical` on those. Everything the
        // watch can actually answer arrives without it.
        return event
    }

    /// The newest unanswered AskUserQuestion in a session, if any.
    func pendingQuestion(in sessionId: String) -> TranscriptEvent? {
        lastUnanswered(kind: "question", in: sessionId)
    }

    private func lastUnanswered(kind: String, in sessionId: String) -> TranscriptEvent? {
        let events = transcripts[sessionId] ?? []
        guard let last = events.last(where: { $0.kind == kind && !($0.requestId ?? "").isEmpty }) else { return nil }
        // Answered once a result/error arrives after it, or a status note says
        // the permission/question was resolved.
        guard let idx = events.lastIndex(where: { $0.id == last.id }) else { return nil }
        let after = events[events.index(after: idx)...]
        if after.contains(where: { $0.kind == "result" || $0.kind == "error" }) { return nil }
        if after.contains(where: { $0.kind == "status" && ($0.note ?? "").hasPrefix("permission ") }) { return nil }
        return last
    }
}
