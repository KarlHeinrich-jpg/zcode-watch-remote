import SwiftUI

@main
struct ZCodeRemoteApp: App {
    @StateObject private var settings: BridgeSettings
    @StateObject private var store: SessionStore

    init() {
        let settings = BridgeSettings()
        _settings = StateObject(wrappedValue: settings)
        _store = StateObject(wrappedValue: SessionStore(settings: settings))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(settings)
                .environmentObject(store)
        }
    }
}
