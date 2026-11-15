import Combine
import Foundation
import MentraBluetoothSDK

/// The Bluetooth link to Mentra Live, for the app's connect screen.
///
/// First time: put the glasses in pairing mode (press the power button 3 times; they say a
/// 4-character code), call `scan()`, and `connect(_:)` the device whose `pairingCode` matches.
/// After that, `connectSaved()` reconnects to the same glasses at launch.
@MainActor
final class MentraGlasses: ObservableObject, MentraBluetoothSDKDelegate {
    enum Status: String, Equatable {
        case disconnected, scanning, connecting, ready
    }

    @Published private(set) var status: Status = .disconnected
    @Published private(set) var found: [Device] = []
    @Published private(set) var lastError: String?

    let sdk: MentraBluetoothSDK
    private var scanSession: ScanSession?

    /// `sdk` defaults to a new `MentraBluetoothSDK()`.
    init(sdk: MentraBluetoothSDK? = nil) {
        let sdk = sdk ?? MentraBluetoothSDK()
        self.sdk = sdk
        sdk.delegate = self
        update(from: sdk.glasses)
    }

    var isReady: Bool { sdk.glasses.ready }
    var hasSavedGlasses: Bool { sdk.defaultDevice != nil }

    /// Reconnect to the glasses paired earlier, if any.
    func connectSaved() {
        guard hasSavedGlasses else {
            lastError = "No saved glasses yet: scan and pick yours first."
            return
        }
        do {
            status = .connecting
            try sdk.connectDefault()
        } catch {
            fail(error)
        }
    }

    /// List nearby Mentra Live glasses for 15 seconds. Never connects by itself:
    /// other teams' glasses may be in the room, so the person picks theirs.
    func scan() {
        scanSession?.stop()
        found = []
        lastError = nil
        status = .scanning
        do {
            scanSession = try sdk.scan(
                model: .mentraLive,
                timeout: 15,
                onResults: { [weak self] devices in self?.found = devices },
                onComplete: { [weak self] devices in
                    guard let self else { return }
                    self.found = devices
                    if self.status == .scanning { self.status = .disconnected }
                }
            )
        } catch {
            fail(error)
        }
    }

    /// Connect to the glasses the person picked (and remember them for `connectSaved()`).
    func connect(_ device: Device) {
        scanSession?.stop()
        do {
            status = .connecting
            try sdk.connect(to: device)
        } catch {
            fail(error)
        }
    }

    func disconnect() {
        sdk.disconnect()
        status = .disconnected
    }

    // MARK: - MentraBluetoothSDKDelegate

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didUpdateGlasses glasses: GlassesRuntimeState) {
        update(from: glasses)
    }

    func mentraBluetoothSDK(_ sdk: MentraBluetoothSDK, didFail error: BluetoothSdkError) {
        lastError = "\(error.message) (\(error.code))"
    }

    private func update(from glasses: GlassesRuntimeState) {
        if glasses.ready {
            status = .ready
        } else if glasses.connected {
            status = .connecting // connected but still starting up
        } else if status != .scanning {
            status = .disconnected
        }
    }

    private func fail(_ error: Error) {
        lastError = (error as? BluetoothSdkError).map { "\($0.message) (\($0.code))" } ?? error.localizedDescription
        if status != .ready { status = .disconnected }
    }
}
