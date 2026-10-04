import Foundation

// MARK: - Wire models (mirror of bridge/src/index.js + hub.js)

/// A session as summarized by the bridge.
struct SessionSummary: Identifiable, Equatable, Decodable {
    let id: String
    var title: String
    var status: String
    var mode: String
    var projectName: String
    var projectPath: String
    var updatedAt: Double
    var lastText: String
    var waitingApproval: Bool

    var displayTitle: String {
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        if !t.isEmpty { return t }
        return projectName.isEmpty ? "New session" : projectName
    }

    var isRunning: Bool { status == "running" }
    var needsAttention: Bool { waitingApproval || status == "waiting" }

    enum CodingKeys: String, CodingKey {
        case id, title, status, mode, projectName, projectPath, updatedAt, lastText, waitingApproval
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = (try? c.decode(String.self, forKey: .title)) ?? ""
        status = (try? c.decode(String.self, forKey: .status)) ?? "idle"
        mode = (try? c.decode(String.self, forKey: .mode)) ?? ""
        projectName = (try? c.decode(String.self, forKey: .projectName)) ?? ""
        projectPath = (try? c.decode(String.self, forKey: .projectPath)) ?? ""
        updatedAt = (try? c.decode(Double.self, forKey: .updatedAt)) ?? 0
        lastText = (try? c.decode(String.self, forKey: .lastText)) ?? ""
        waitingApproval = (try? c.decode(Bool.self, forKey: .waitingApproval)) ?? false
    }

    init(id: String, title: String, status: String, mode: String, projectName: String,
         projectPath: String, updatedAt: Double, lastText: String, waitingApproval: Bool) {
        self.id = id; self.title = title; self.status = status; self.mode = mode
        self.projectName = projectName; self.projectPath = projectPath
        self.updatedAt = updatedAt; self.lastText = lastText; self.waitingApproval = waitingApproval
    }
}

/// One entry in a session transcript.
struct TranscriptEvent: Identifiable, Equatable, Decodable {
    let id = UUID()
    var kind: String        // text | tool | permission | status | result | error
    var role: String?       // user | assistant
    var text: String?
    var tool: String?
    var state: String?      // started | done
    var detail: String?
    var status: String?
    var message: String?
    var requestId: String?
    var isError: Bool?

    enum CodingKeys: String, CodingKey {
        case kind, role, text, tool, state, detail, status, message, requestId, isError
    }

    var symbol: String {
        switch kind {
        case "text": return role == "user" ? "person.fill" : "sparkle"
        case "tool": return state == "done" ? "checkmark.circle" : "hammer"
        case "permission": return "hand.raised.fill"
        case "result": return isError == true ? "exclamationmark.triangle" : "flag.checkered"
        case "error": return "exclamationmark.octagon"
        default: return "circle.dashed"
        }
    }

    static func == (lhs: TranscriptEvent, rhs: TranscriptEvent) -> Bool { lhs.id == rhs.id }
}

/// A project the bridge allows new sessions in.
struct ProjectRef: Identifiable, Equatable, Decodable {
    var id: String { path }
    let path: String
    let name: String
}

/// Everything the bridge can send to the watch.
enum BridgeMessage {
    case paired(token: String, bridgeName: String, projects: [ProjectRef], sessions: [SessionSummary])
    case welcome(bridgeName: String, projects: [ProjectRef], sessions: [SessionSummary])
    case sessions([SessionSummary])
    case sessionCreated(sessionId: String)
    case sessionState(sessionId: String, status: String, events: [TranscriptEvent])
    case sessionEvent(sessionId: String, event: TranscriptEvent)
    case promptAccepted(sessionId: String)
    case permissionAccepted(sessionId: String, requestId: String)
    case externalEvent(event: String, message: String, project: String)
    case pong
    case bridgeError(code: String, message: String)
    case unknown(String)

    /// Decode a raw text frame. Unknown types are reported instead of dropped so
    /// version drift is visible rather than silent.
    static func decode(_ text: String) -> BridgeMessage? {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = obj["type"] as? String else { return nil }

        func sessions() -> [SessionSummary] {
            guard let arr = obj["sessions"] as? [[String: Any]] else { return [] }
            return arr.compactMap { dict in
                guard let d = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
                return try? JSONDecoder().decode(SessionSummary.self, from: d)
            }
        }
        func projects() -> [ProjectRef] {
            guard let arr = obj["projects"] as? [[String: Any]] else { return [] }
            return arr.compactMap { dict in
                guard let d = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
                return try? JSONDecoder().decode(ProjectRef.self, from: d)
            }
        }
        func events() -> [TranscriptEvent] {
            guard let arr = obj["events"] as? [[String: Any]] else { return [] }
            return arr.compactMap { dict in
                guard let d = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
                return try? JSONDecoder().decode(TranscriptEvent.self, from: d)
            }
        }
        func event() -> TranscriptEvent? {
            guard let dict = obj["ev"] as? [String: Any],
                  let d = try? JSONSerialization.data(withJSONObject: dict) else { return nil }
            return try? JSONDecoder().decode(TranscriptEvent.self, from: d)
        }

        switch type {
        case "paired":
            return .paired(token: obj["token"] as? String ?? "",
                           bridgeName: obj["bridgeName"] as? String ?? "ZCode",
                           projects: projects(), sessions: sessions())
        case "welcome":
            return .welcome(bridgeName: obj["bridgeName"] as? String ?? "ZCode",
                            projects: projects(), sessions: sessions())
        case "sessions":
            return .sessions(sessions())
        case "session-created":
            return .sessionCreated(sessionId: obj["sessionId"] as? String ?? "")
        case "session-state":
            return .sessionState(sessionId: obj["sessionId"] as? String ?? "",
                                 status: obj["status"] as? String ?? "idle",
                                 events: events())
        case "session-event":
            guard let ev = event() else { return nil }
            return .sessionEvent(sessionId: obj["sessionId"] as? String ?? "", event: ev)
        case "prompt-accepted":
            return .promptAccepted(sessionId: obj["sessionId"] as? String ?? "")
        case "permission-accepted":
            return .permissionAccepted(sessionId: obj["sessionId"] as? String ?? "",
                                       requestId: obj["requestId"] as? String ?? "")
        case "external-event":
            return .externalEvent(event: obj["event"] as? String ?? "notification",
                                  message: obj["message"] as? String ?? "",
                                  project: obj["project"] as? String ?? "")
        case "pong":
            return .pong
        case "error":
            return .bridgeError(code: obj["error"] as? String ?? "error",
                                message: obj["message"] as? String ?? "Unknown error")
        default:
            return .unknown(type)
        }
    }
}

// MARK: - Outgoing messages

enum OutgoingMessage {
    case pair(pin: String, device: String)
    case hello(token: String, device: String)
    case sessionsList
    case newSession(projectPath: String)
    case sessionOpen(sessionId: String)
    case prompt(sessionId: String, text: String)
    case interrupt(sessionId: String)
    case permissionResponse(sessionId: String, requestId: String, allow: Bool)
    case setMode(sessionId: String, mode: String)
    case ping

    var json: String {
        var dict: [String: Any] = [:]
        switch self {
        case .pair(let pin, let device):
            dict = ["type": "pair", "pin": pin, "device": device]
        case .hello(let token, let device):
            dict = ["type": "hello", "token": token, "device": device]
        case .sessionsList:
            dict = ["type": "sessions-list"]
        case .newSession(let path):
            dict = ["type": "new-session", "projectPath": path]
        case .sessionOpen(let id):
            dict = ["type": "session-open", "sessionId": id]
        case .prompt(let id, let text):
            dict = ["type": "prompt", "sessionId": id, "text": text]
        case .interrupt(let id):
            dict = ["type": "interrupt", "sessionId": id]
        case .permissionResponse(let id, let requestId, let allow):
            dict = ["type": "permission-response", "sessionId": id, "requestId": requestId, "allow": allow]
        case .setMode(let id, let mode):
            dict = ["type": "set-mode", "sessionId": id, "mode": mode]
        case .ping:
            dict = ["type": "ping"]
        }
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let s = String(data: data, encoding: .utf8) else { return "{}" }
        return s
    }
}
