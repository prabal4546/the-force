import Foundation

protocol DockControlling {
    func acquireAndTrack(person: TargetID) async throws
    func stop() async
}

enum DockControlError: Error {
    case disconnected
    case targetNotPerson
    case targetNotFound
    case trackingLost
}

actor MockDockController: DockControlling {
    private(set) var trackedPerson: TargetID?

    func acquireAndTrack(person: TargetID) async throws {
        guard person.isPerson else { throw DockControlError.targetNotPerson }
        trackedPerson = person
    }

    func stop() async {
        trackedPerson = nil
    }
}

// Hardware owner: implement DockKitController here. Disable system tracking,
// scan a calibrated arc, identify the requested QR payload, and feed its
// normalized bounding box to DockKit as a custom object observation.
