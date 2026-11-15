import Foundation
import MentraBluetoothSDK
import MentraBridgeCore

/// What one capture found.
struct CaptureResult {
    let requestId: String
    let trigger: String
    /// The marker's target id, or nil when the photo had no known marker or the capture failed.
    var target: String?
    var error: String?
    var milliseconds = 0
    var bytes = 0
    var codes = 0
    /// True when the device API took the photo (for the agent).
    var uploaded = false

    var json: [String: Any] {
        [
            "requestId": requestId, "trigger": trigger, "target": target ?? NSNull(), "error": error ?? NSNull(),
            "ms": milliseconds, "bytes": bytes, "codes": codes, "uploaded": uploaded,
        ]
    }

    var summary: String {
        if let error { return "Capture failed after \(milliseconds) ms: \(error)" }
        if let target { return "Locked: \(target)  (\(milliseconds) ms, \(bytes / 1024) KB)" }
        return "No marker in view  (\(milliseconds) ms, \(codes) other QR code\(codes == 1 ? "" : "s"))"
    }
}

/// LOOK -> target lock. Asks the glasses for a photo over Bluetooth, reads the QR marker
/// nearest the middle of it and publishes `target.detected` to the Mac runtime.
///
/// The photo never leaves Bluetooth: `localFile` makes the SDK pull the JPEG straight over
/// BLE into a file on this Mac, so there is no Wi-Fi upload to attempt, no webhook and no phone.
@MainActor
final class TargetCapture {
    private let sdk: MentraBluetoothSDK
    private let link: RuntimeLink
    private let api: ApiUpload

    var size = PhotoSize(rawValue: UserDefaults.standard.string(forKey: "photoSize") ?? "") ?? .medium {
        didSet { UserDefaults.standard.set(size.rawValue, forKey: "photoSize") }
    }

    /// The photo's size over Bluetooth is most of the wait: high compression is about twice as fast as none.
    var compress = PhotoCompression(rawValue: UserDefaults.standard.string(forKey: "photoCompress") ?? "") ?? .high {
        didSet { UserDefaults.standard.set(compress.rawValue, forKey: "photoCompress") }
    }

    /// Photo after photo while the glasses are connected, so looking at a marker is enough to lock it.
    var auto = UserDefaults.standard.bool(forKey: "autoLock") {
        didSet {
            UserDefaults.standard.set(auto, forKey: "autoLock")
            runLoops()
        }
    }

    /// Hold the camera open between photos. Faster captures; costs glasses battery.
    var keepWarm = UserDefaults.standard.object(forKey: "keepWarm") as? Bool ?? true {
        didSet {
            UserDefaults.standard.set(keepWarm, forKey: "keepWarm")
            // Start over, so turning this back on retries after earlier failures.
            warmFailures = 0
            warmTask?.cancel()
            warmTask = nil
            runLoops()
        }
    }

    private(set) var last: CaptureResult?
    private(set) var lastPhoto: Data?
    private(set) var captures = 0
    var onResult: ((CaptureResult) -> Void)?
    var onLog: ((String) -> Void)?

    private var inFlight: Task<CaptureResult, Never>?
    private var autoTask: Task<Void, Never>?
    private var warmTask: Task<Void, Never>?
    private var warmFailures = 0

    init(sdk: MentraBluetoothSDK, link: RuntimeLink, api: ApiUpload) {
        self.sdk = sdk
        self.link = link
        self.api = api
    }

    var status: [String: Any] {
        [
            "auto": auto, "keepWarm": keepWarm, "size": size.rawValue, "compress": compress.rawValue, "captures": captures,
            "target": link.target ?? NSNull(), "lastCapture": last?.json ?? NSNull(),
        ]
    }

    /// Takes one photo and reads it. A second caller while one is in flight shares its result.
    func capture(trigger: String) async -> CaptureResult {
        if let inFlight { return await inFlight.value }
        let started = Date()
        let task = Task { @MainActor in
            var result = await self.captureNow(trigger: trigger)
            // The agent answers spoken commands from the newest photo the API holds. The auto
            // loop's photos stay here: one every few seconds would only fill the API's disk.
            if result.error == nil, trigger != "auto", let photo = self.lastPhoto {
                result.uploaded = await self.api.upload(photo: photo, requestId: result.requestId)
            }
            result.milliseconds = Int(Date().timeIntervalSince(started) * 1000)
            return result
        }
        inFlight = task
        let result = await task.value
        inFlight = nil
        last = result
        captures += 1
        // The auto loop repeats the same lock many times a minute; only real changes are news.
        if let target = result.target, trigger != "auto" || target != link.target || !link.connected {
            let sent = link.publish(target: target)
            onLog?("Target \(target) from \(trigger) capture in \(result.milliseconds) ms\(sent ? "" : " (Mac runtime not connected; will send on reconnect)")")
        }
        onResult?(result)
        return result
    }

    private func captureNow(trigger: String) async -> CaptureResult {
        let request = PhotoRequest(size: size, compress: compress, sound: false, localFile: true)
        var result = CaptureResult(requestId: request.requestId, trigger: trigger)
        guard sdk.glasses.ready else {
            result.error = "glasses not connected"
            return result
        }
        do {
            let event = try await sdk.requestPhoto(request)
            guard case let .success(_, _, photoUrl, _, _, _, _) = event.response,
                  let photoUrl, let file = URL(string: photoUrl), file.isFileURL
            else {
                if case let .error(_, code, message, _) = event.response {
                    result.error = [code, message].compactMap { $0 }.joined(separator: ": ")
                } else {
                    result.error = "the glasses returned no photo file"
                }
                return result
            }
            let data = try Data(contentsOf: file)
            try? FileManager.default.removeItem(at: file)
            result.bytes = data.count
            lastPhoto = data
            let codes = try await Task.detached(priority: .userInitiated) { try MarkerDecoder.decode(data) }.value
            result.codes = codes.count
            result.target = TargetPicker.pick(codes)?.target
        } catch {
            result.error = "\(error)"
        }
        return result
    }

    // MARK: - Loops

    /// Call when the glasses connect or disconnect, or a setting changes.
    func runLoops() {
        let ready = sdk.glasses.ready
        if !ready { warmFailures = 0 }

        if auto, ready, autoTask == nil {
            autoTask = Task { @MainActor in
                while !Task.isCancelled, self.auto, self.sdk.glasses.ready {
                    let result = await self.capture(trigger: "auto")
                    // Back off after a failure so a busy camera is not hammered.
                    try? await Task.sleep(nanoseconds: result.error == nil ? 150_000_000 : 1_500_000_000)
                }
            }
        } else if !auto || !ready {
            autoTask?.cancel()
            autoTask = nil
        }

        if keepWarm, ready, warmTask == nil {
            warmTask = Task { @MainActor in
                while !Task.isCancelled, self.keepWarm, self.sdk.glasses.ready, self.warmFailures < 3 {
                    do {
                        _ = try await self.sdk.warmUpCamera(size: self.size, exposureTimeNs: nil, durationMs: 30000)
                        self.warmFailures = 0
                        try? await Task.sleep(nanoseconds: 20_000_000_000)
                    } catch {
                        // A photo or transfer in flight is expected; older glasses software may not warm up at all.
                        let busy = "\(error)".contains("busy") || "\(error)".contains("in_progress") || "\(error)".contains("cooldown")
                        if !busy {
                            self.warmFailures += 1
                            self.onLog?("Camera warm-up failed (\(self.warmFailures)/3): \(error)")
                        }
                        try? await Task.sleep(nanoseconds: 3_000_000_000)
                    }
                }
            }
        } else if !keepWarm || !ready {
            warmTask?.cancel()
            warmTask = nil
        }
    }
}
