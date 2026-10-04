import Foundation
import SwiftUI

/// Connection + pairing state, persisted across launches.
@MainActor
final class BridgeSettings: ObservableObject {
    private enum Keys {
        static let host = "bridge.host"
        static let token = "bridge.token"
        static let bridgeName = "bridge.name"
        static let deviceName = "bridge.deviceName"
    }

    @AppStorage(Keys.host) var host: String = "" { didSet { objectWillChange.send() } }
    @AppStorage(Keys.token) var token: String = "" { didSet { objectWillChange.send() } }
    @AppStorage(Keys.bridgeName) var bridgeName: String = "" { didSet { objectWillChange.send() } }
    @AppStorage(Keys.deviceName) var deviceName: String = defaultDeviceName() { didSet { objectWillChange.send() } }

    var isPaired: Bool { !host.isEmpty && !token.isEmpty }

    /// Turn user input like "192.168.1.5", "192.168.1.5:8788" or
    /// "ws://192.168.1.5:8788/ws" into a websocket URL.
    static func websocketURL(from input: String) -> URL? {
        var s = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !s.isEmpty else { return nil }
        if !s.contains("://") { s = "ws://" + s }
        guard var comps = URLComponents(string: s) else { return nil }
        if comps.port == nil { comps.port = 8788 }
        if comps.path.isEmpty || comps.path == "/" { comps.path = "/ws" }
        return comps.url
    }

    func save(host rawHost: String, token: String, bridgeName: String) {
        self.host = rawHost.trimmingCharacters(in: .whitespacesAndNewlines)
        self.token = token
        self.bridgeName = bridgeName
    }

    func unpair() {
        host = ""
        token = ""
        bridgeName = ""
    }

    private static func defaultDeviceName() -> String {
        #if os(watchOS)
        return "Apple Watch"
        #else
        return "Device"
        #endif
    }
}
