import Foundation

/// A pretend `TargetSource` for the mocked product (Milestone 1) and for tests.
///
/// It answers from a script, in a loop: `MockTargetSource([.mac, .externalDisplay])` answers
/// `.mac`, then `.externalDisplay`, then `.mac` again. `setNext(_:)` overrides the next answer
/// (for a keyboard or button in the iOS shell), `failNext(_:)` makes the next look fail.
actor MockTargetSource: TargetSource {
    private var script: [TargetID]
    private var index = 0
    private var forced: Result<TargetID, Error>?
    private let delayNanoseconds: UInt64

    init(_ script: [TargetID] = [.mac, .externalDisplay, .personBlue, .gimbal], delaySeconds: Double = 0.4) {
        self.script = script.isEmpty ? [.mac] : script
        self.delayNanoseconds = UInt64(max(0, delaySeconds) * 1_000_000_000)
    }

    func setNext(_ target: TargetID) { forced = .success(target) }
    func failNext(_ error: Error = MentraInputError.noMarker(seen: [])) { forced = .failure(error) }

    func captureTarget() async throws -> TargetID {
        try await Task.sleep(nanoseconds: delayNanoseconds) // feels like a real photo
        if let next = forced {
            forced = nil
            return try next.get()
        }
        defer { index = (index + 1) % script.count }
        return script[index]
    }
}
