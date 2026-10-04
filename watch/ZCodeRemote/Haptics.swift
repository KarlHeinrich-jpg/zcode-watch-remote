import Foundation
#if os(watchOS)
import WatchKit
#endif

/// Haptic feedback for the moments that matter when your wrist is down.
enum Haptics {
    /// The agent is blocked on a tool approval — the one alert worth buzzing for.
    static func approvalNeeded() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.notification)
        #endif
    }

    /// A turn finished.
    static func turnFinished(success: Bool) {
        #if os(watchOS)
        WKInterfaceDevice.current().play(success ? .success : .failure)
        #endif
    }

    /// A message from a ZCode hook (notification / stop events).
    static func hookNotice() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.directionUp)
        #endif
    }

    static func tap() {
        #if os(watchOS)
        WKInterfaceDevice.current().play(.click)
        #endif
    }
}
