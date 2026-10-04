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
            transcripts[id, default: []].append(event)
            if transcripts[id]!.count > 200 { transcripts[id]!.removeFirst(transcripts[id]!.count - 200) }
            if currentSessionId != id {
                unread.insert(id)
            }
            react(to: event, in: id)

        case .promptAccepted:
            Haptics.tap()

        case .permissionAccepted:
            Haptics.turnFinished(success: true)

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

    private func react(to event: TranscriptEvent, in sessionId: String) {
        switch event.kind {
        case "permission":
            Haptics.approvalNeeded()
            banner = "Approval needed: \(event.tool ?? "tool")"
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

    func respond(allow: Bool, sessionId: String, requestId: String) {
        client.send(.permissionResponse(sessionId: sessionId, requestId: requestId, allow: allow))
        Haptics.turnFinished(success: allow)
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

    /// The oldest unanswered approval request in a session, if any.
    func pendingApproval(in sessionId: String) -> TranscriptEvent? {
        let events = transcripts[sessionId] ?? []
        let requests = events.filter { $0.kind == "permission" }
        guard let last = requests.last else { return nil }
        // An approval is cleared by a later result/status event.
        if let lastIndex = events.lastIndex(where: { $0.id == last.id }) {
            let after = events.suffix(from: events.index(after: lastIndex))
            if after.contains(where: { $0.kind == "result" || $0.kind == "error" }) { return nil }
        }
        return last
    }
}
