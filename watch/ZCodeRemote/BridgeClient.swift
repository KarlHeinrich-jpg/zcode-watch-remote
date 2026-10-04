import Foundation

/// WebSocket client for the bridge, using URLSessionWebSocketTask.
/// Handles connect/reconnect with backoff and keepalive pings.
final class BridgeClient: NSObject, URLSessionWebSocketDelegate {
    enum State: Equatable {
        case idle
        case connecting
        case connected
        case waitingToReconnect(seconds: Int)
        case failed(String)
    }

    var onStateChange: ((State) -> Void)?
    var onMessage: ((BridgeMessage) -> Void)?

    private(set) var state: State = .idle {
        didSet { if state != oldValue { onStateChange?(state) } }
    }

    private var session: URLSession!
    private var task: URLSessionWebSocketTask?
    private var reconnectAttempt = 0
    private var reconnectWork: DispatchWorkItem?
    private var pingTimer: Timer?
    private var url: URL?
    private var shouldRun = false
    private let queue = DispatchQueue(label: "bridge.client")

    override init() {
        super.init()
        let config = URLSessionConfiguration.default
        config.waitsForConnectivity = false
        config.timeoutIntervalForRequest = 15
        session = URLSession(configuration: config, delegate: self, delegateQueue: nil)
    }

    // MARK: - Lifecycle

    func connect(to url: URL) {
        queue.async { [weak self] in
            guard let self else { return }
            self.url = url
            self.shouldRun = true
            self.reconnectAttempt = 0
            self.openTask(url)
        }
    }

    func disconnect() {
        queue.async { [weak self] in
            guard let self else { return }
            self.shouldRun = false
            self.reconnectWork?.cancel()
            self.stopPing()
            self.task?.cancel(with: .goingAway, reason: nil)
            self.task = nil
            self.state = .idle
        }
    }

    func send(_ message: OutgoingMessage) {
        queue.async { [weak self] in
            guard let task = self?.task else { return }
            task.send(.string(message.json)) { _ in }
        }
    }

    private func openTask(_ url: URL) {
        task?.cancel(with: .goingAway, reason: nil)
        state = .connecting
        let t = session.webSocketTask(with: url)
        task = t
        t.resume()
        receiveLoop(on: t)
        startPing()
    }

    private func startPing() {
        stopPing()
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.pingTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
                self?.queue.async {
                    self?.task?.sendPing { _ in }
                }
            }
        }
    }

    private func stopPing() {
        DispatchQueue.main.async { [weak self] in
            self?.pingTimer?.invalidate()
            self?.pingTimer = nil
        }
    }

    private func receiveLoop(on task: URLSessionWebSocketTask) {
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure(let error):
                self.queue.async { self.handleDisconnect(error) }
            case .success(let message):
                switch message {
                case .string(let text):
                    if let parsed = BridgeMessage.decode(text) {
                        self.onMessage?(parsed)
                    }
                case .data(let data):
                    if let text = String(data: data, encoding: .utf8),
                       let parsed = BridgeMessage.decode(text) {
                        self.onMessage?(parsed)
                    }
                @unknown default:
                    break
                }
                self.queue.async { self.receiveLoop(on: task) }
            }
        }
    }

    private func handleDisconnect(_ error: Error?) {
        guard shouldRun else { return }
        stopPing()
        task = nil
        reconnectAttempt += 1
        let delay = min(30, Int(pow(2.0, Double(min(reconnectAttempt, 5)))))
        state = .waitingToReconnect(seconds: delay)
        let work = DispatchWorkItem { [weak self] in
            guard let self, self.shouldRun, let url = self.url else { return }
            self.openTask(url)
        }
        reconnectWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + .seconds(delay), execute: work)
    }

    // MARK: - URLSessionWebSocketDelegate

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didOpenWithProtocol protocol: String?) {
        queue.async { [weak self] in
            guard let self else { return }
            self.reconnectAttempt = 0
            self.state = .connected
        }
    }

    func urlSession(_ session: URLSession, webSocketTask: URLSessionWebSocketTask,
                    didCloseWith closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        queue.async { [weak self] in
            guard let self else { return }
            if closeCode == .policyViolation || closeCode.rawValue == 4001 || closeCode.rawValue == 4003 {
                // Bridge rejected our credentials: stop retrying, ask the user to re-pair.
                self.shouldRun = false
                self.state = .failed("Pairing rejected — pair again")
                self.onMessage?(.bridgeError(code: "unauthorized", message: "Pairing rejected — pair again"))
            } else {
                self.handleDisconnect(nil)
            }
        }
    }
}
