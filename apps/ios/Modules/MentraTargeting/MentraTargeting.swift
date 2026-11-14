import Foundation

protocol TargetSource {
    func captureTarget() async throws -> TargetID
}

enum TargetSourceError: Error {
    case disconnected
    case uploadTimedOut
    case noMarkerFound
    case ambiguousMarkers
}

// The real source is Mentra/MentraTargetSource.swift (glasses photo -> QR marker -> TargetID).
// Mentra/MockTargetSource.swift is the scripted stand-in for the mocked flow and tests.
