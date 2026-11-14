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

struct MockTargetSource: TargetSource {
    var nextTarget: TargetID

    func captureTarget() async throws -> TargetID {
        nextTarget
    }
}

// Hardware owner: implement MentraTargetSource here using MentraBluetoothSDK.
// Request one photo, receive it through the local iPhone upload endpoint, then
// use Vision barcode recognition to return exactly one TargetID.
