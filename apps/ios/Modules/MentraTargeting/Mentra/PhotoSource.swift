import Foundation
import MentraBluetoothSDK

/// One photo from the glasses.
struct CapturedPhoto: Sendable {
    let requestId: String
    let data: Data
    let requestedAt: Date
    let receivedAt: Date

    init(requestId: String, data: Data, requestedAt: Date, receivedAt: Date) {
        self.requestId = requestId
        self.data = data
        self.requestedAt = requestedAt
        self.receivedAt = receivedAt
    }

    var milliseconds: Int { Int(receivedAt.timeIntervalSince(requestedAt) * 1000) }
}

/// Something that can take a photo on demand. Real glasses, or a stand-in for tests.
@MainActor
protocol PhotoSource: AnyObject {
    func capturePhoto() async throws -> CapturedPhoto
}

/// Takes a photo with Mentra Live and gets the JPEG onto this iPhone.
///
/// The glasses upload it over Wi-Fi to `GlassesMediaReceiver` on this iPhone; if Wi-Fi does not
/// work, the SDK brings it over Bluetooth and uploads it here itself (slower: a few seconds).
@MainActor
final class MentraPhotoSource: PhotoSource {
    let glasses: MentraGlasses
    let receiver: GlassesMediaReceiver
    var size: PhotoSize
    var compress: PhotoCompression
    /// Give up on one photo after this long.
    var timeout: TimeInterval
    private var warmTask: Task<Void, Never>?

    init(
        glasses: MentraGlasses,
        receiver: GlassesMediaReceiver = GlassesMediaReceiver(),
        size: PhotoSize = .medium,
        compress: PhotoCompression = .medium,
        timeout: TimeInterval = 15
    ) {
        self.glasses = glasses
        self.receiver = receiver
        self.size = size
        self.compress = compress
        self.timeout = timeout
    }

    func capturePhoto() async throws -> CapturedPhoto {
        guard glasses.isReady else { throw MentraInputError.glassesNotReady }
        try await receiver.start()
        let requestId = "bodyos-\(UUID().uuidString.prefix(8).lowercased())"
        let requestedAt = Date()

        // Start waiting before asking, so an upload that arrives early is not missed.
        let receiver = receiver
        let timeout = timeout
        async let upload = receiver.waitForUpload(requestId: requestId, timeout: timeout)

        let event = try await glasses.sdk.requestPhoto(PhotoRequest(
            requestId: requestId,
            size: size,
            webhookUrl: receiver.uploadURL,
            compress: compress,
            save: false,
            sound: false
        ))
        if case let .error(_, code, message, _) = event.response {
            throw MentraInputError.photoFailed([code, message].compactMap { $0 }.joined(separator: ": "))
        }
        let media = try await upload
        let data = try Data(contentsOf: media.fileURL)
        try? FileManager.default.removeItem(at: media.fileURL) // CaptureLog keeps its own copy
        return CapturedPhoto(requestId: requestId, data: data, requestedAt: requestedAt, receivedAt: Date())
    }

    /// Keep the glasses' camera open so the next photo skips most of its start-up time.
    /// Uses battery: call it while the demo runs, `stopKeepingWarm()` after.
    func keepWarm() {
        warmTask?.cancel()
        warmTask = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                if self.glasses.isReady {
                    _ = try? await self.glasses.sdk.warmUpCamera(size: self.size, exposureTimeNs: nil, durationMs: 30_000)
                }
                try? await Task.sleep(nanoseconds: 20_000_000_000) // refresh before the 30 s lease ends
            }
        }
    }

    func stopKeepingWarm() {
        warmTask?.cancel()
        warmTask = nil
    }
}
