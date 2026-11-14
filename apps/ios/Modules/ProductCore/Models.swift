import Foundation

enum TargetID: String, Codable, CaseIterable, Sendable {
    case mac
    case externalDisplay
    case gimbal
    case personRed
    case personBlue

    var label: String {
        switch self {
        case .mac: return "Mac"
        case .externalDisplay: return "External display"
        case .gimbal: return "Gimbal"
        case .personRed: return "Red person"
        case .personBlue: return "Blue person"
        }
    }

    var isPerson: Bool {
        self == .personRed || self == .personBlue
    }
}

enum GestureName: String, Codable, Sendable {
    case grab
    case throwGesture = "throw"
}

enum TrackingState: String, Codable, Sendable {
    case idle
    case searching
    case tracking
    case lost
    case failure
}

enum CarriedPayload: Equatable, Sendable {
    case window(token: String)
    case attention(person: TargetID)
}

enum DemoState: Equatable, Sendable, CustomStringConvertible {
    case idle
    case acquiringSource
    case capturingWindow
    case carrying(CarriedPayload)
    case acquiringDestination(CarriedPayload)
    case executing
    case tracking(TargetID)
    case failed(String)

    var description: String {
        switch self {
        case .idle: return "Idle"
        case .acquiringSource: return "Looking for source"
        case .capturingWindow: return "Capturing window"
        case .carrying(let payload): return "Carrying \(payload)"
        case .acquiringDestination: return "Looking for destination"
        case .executing: return "Executing"
        case .tracking(let person): return "Tracking \(person.label)"
        case .failed(let message): return "Failed: \(message)"
        }
    }
}

enum ProductEvent: Sendable {
    case gesture(GestureName)
    case targetDetected(TargetID)
    case windowCaptured(token: String)
    case windowMoveFinished(success: Bool)
    case trackingChanged(person: TargetID, state: TrackingState)
}

enum CapturePurpose: Sendable {
    case source
    case destination
}

enum VexoLEDColor: String, Sendable {
    case off, yellow, green, red, blue, white
}

enum ProductCommand: Sendable, CustomStringConvertible {
    case requestTargetCapture(CapturePurpose)
    case captureFrontmostWindow
    case moveWindow(token: String)
    case trackPerson(TargetID)
    case setVexoLED(VexoLEDColor)

    var description: String {
        switch self {
        case .requestTargetCapture(let purpose): return "Mentra capture: \(purpose)"
        case .captureFrontmostWindow: return "Capture frontmost window"
        case .moveWindow(let token): return "Move window \(token)"
        case .trackPerson(let person): return "Track \(person.label)"
        case .setVexoLED(let color): return "Vexo LED: \(color.rawValue)"
        }
    }
}
