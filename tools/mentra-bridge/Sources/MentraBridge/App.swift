import AppKit
import MentraBluetoothSDK
import MentraBridgeCore

@main
@MainActor
struct MentraBridgeApp {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.setActivationPolicy(.regular)
        application.delegate = delegate
        application.run()
        withExtendedLifetime(delegate) {}
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, MentraBluetoothSDKDelegate, NSTextFieldDelegate {
    /// Our own record of the glasses to return to; the SDK's default device does not survive a relaunch.
    private static let glassesKey = "glassesName"

    private let sdk = MentraBluetoothSDK()
    private let link = RuntimeLink()
    private lazy var capture = TargetCapture(sdk: sdk, link: link)
    private let server = ControlServer()

    private var window: NSWindow!
    private let picker = NSPopUpButton()
    private let glassesStatus = NSTextField(wrappingLabelWithString: "Glasses: disconnected")
    private let runtimeStatus = NSTextField(wrappingLabelWithString: "")
    private let runtimeAddress = NSTextField(string: "")
    private let result = NSTextField(wrappingLabelWithString: "No capture yet")
    private let log = NSTextField(wrappingLabelWithString: "")
    private let preview = NSImageView()
    private var scanButton: NSButton!
    private var pairButton: NSButton!
    private var connectButton: NSButton!
    private var captureButton: NSButton!
    private var autoBox: NSButton!
    private var warmBox: NSButton!
    private let sizePicker = NSPopUpButton()
    private static let sizes: [(PhotoSize, String)] = [
        (.low, "Fast: 640 px, about 2 s"), (.medium, "Sharp: 1280 px, about 3 s"),
    ]

    private var devices: [Device] = []
    private var scanSession: ScanSession?
    private var reconnectScan: ScanSession?
    /// False after Disconnect or Unpair, so the bridge stops chasing glasses the person put away.
    private var wantConnection = true
    private var retryTimer: Timer?
    private var stalled = 0

    private var knownGlasses: String? {
        UserDefaults.standard.string(forKey: Self.glassesKey)
            ?? UserDefaults.standard.string(forKey: "MentraLiveLastConnectedDeviceName")
    }

    func applicationDidFinishLaunching(_: Notification) {
        sdk.delegate = self
        buildWindow()

        link.onChange = { [weak self] in self?.refresh() }
        link.onLog = { [weak self] in self?.say($0) }
        capture.onLog = { [weak self] in self?.say($0) }
        capture.onResult = { [weak self] in self?.show($0) }
        server.onLog = { [weak self] in self?.say($0) }
        server.route = { [weak self] request in await self?.route(request) ?? (503, ["error": "shutting down"]) }
        link.start()
        server.start()

        // Unattended start: go back to the last glasses, and keep trying while they are away.
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in self?.reconnect(named: nil) }
        retryTimer = Timer.scheduledTimer(withTimeInterval: 8, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.wantConnection, !self.sdk.glasses.ready,
                      self.reconnectScan == nil, self.scanSession == nil else { return }
                if self.sdk.glasses.connection == .disconnected {
                    self.stalled = 0
                    self.reconnect(named: nil)
                } else {
                    // Stuck halfway (the glasses were still tied to an earlier session): drop the attempt and start again.
                    self.stalled += 1
                    if self.stalled >= 3 {
                        self.stalled = 0
                        self.say("Connection stalled; starting again")
                        self.sdk.disconnect()
                    }
                }
            }
        }
        refresh()
    }

    // MARK: - Window

    private func buildWindow() {
        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 640, height: 700),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        window.title = "The Force: Mentra Bridge"
        window.minSize = NSSize(width: 520, height: 520)
        let stack = NSStackView()
        stack.orientation = .vertical
        stack.alignment = .leading
        stack.spacing = 12
        stack.edgeInsets = NSEdgeInsets(top: 20, left: 20, bottom: 20, right: 20)
        stack.translatesAutoresizingMaskIntoConstraints = false
        window.contentView!.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.leadingAnchor.constraint(equalTo: window.contentView!.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: window.contentView!.trailingAnchor),
            stack.topAnchor.constraint(equalTo: window.contentView!.topAnchor),
            stack.bottomAnchor.constraint(equalTo: window.contentView!.bottomAnchor),
        ])

        scanButton = NSButton(title: "Scan", target: self, action: #selector(scan))
        pairButton = NSButton(title: "Pair", target: self, action: #selector(pairOrUnpair))
        connectButton = NSButton(title: "Connect", target: self, action: #selector(connectOrDisconnect))
        picker.widthAnchor.constraint(greaterThanOrEqualToConstant: 200).isActive = true
        let connection = NSStackView(views: [scanButton, picker, connectButton, pairButton])

        runtimeAddress.placeholderString = "Mac runtime address (127.0.0.1:8765)"
        runtimeAddress.stringValue = UserDefaults.standard.string(forKey: RuntimeLink.addressKey) ?? ""
        runtimeAddress.delegate = self

        captureButton = NSButton(title: "Capture target", target: self, action: #selector(captureNow))
        captureButton.keyEquivalent = "\r"
        autoBox = NSButton(checkboxWithTitle: "Auto-lock (photo after photo)", target: self, action: #selector(toggleAuto))
        warmBox = NSButton(checkboxWithTitle: "Keep camera warm", target: self, action: #selector(toggleWarm))
        sizePicker.addItems(withTitles: Self.sizes.map(\.1))
        sizePicker.target = self
        sizePicker.action = #selector(pickSize)
        let controls = NSStackView(views: [captureButton, sizePicker, autoBox, warmBox])

        result.font = .systemFont(ofSize: 20, weight: .semibold)
        log.textColor = .secondaryLabelColor
        for label in [glassesStatus, runtimeStatus, result, log] { label.isSelectable = true }
        preview.imageScaling = .scaleProportionallyUpOrDown
        for axis in [NSLayoutConstraint.Orientation.horizontal, .vertical] {
            preview.setContentCompressionResistancePriority(.defaultLow, for: axis)
            preview.setContentHuggingPriority(.defaultLow, for: axis)
        }

        let rows: [NSView] = [connection, glassesStatus, runtimeAddress, runtimeStatus, controls, result, log, preview]
        for row in rows {
            stack.addArrangedSubview(row)
            row.widthAnchor.constraint(equalTo: stack.widthAnchor, constant: -40).isActive = true
        }
        preview.heightAnchor.constraint(greaterThanOrEqualToConstant: 240).isActive = true

        let menu = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "Quit", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        menu.addItem(appItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        menu.addItem(editItem)
        NSApplication.shared.mainMenu = menu
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApplication.shared.activate(ignoringOtherApps: true)
    }

    private var paired: Bool {
        sdk.glasses.connection != .disconnected || knownGlasses != nil
    }

    private func refresh() {
        let glasses = sdk.glasses
        let disconnected = glasses.connection == .disconnected
        glassesStatus.stringValue = glasses.connected
            ? "Glasses: \(glasses.device?.bluetoothName ?? "connected")  |  battery \(glasses.battery?.level.map(String.init) ?? "?")%  |  software \(glasses.device?.appVersion ?? "?")"
            : "Glasses: \(glasses.connection.rawValue)\(knownGlasses.map { " (looking for \($0))" } ?? "")"
        runtimeStatus.stringValue = "Mac runtime: \(link.connected ? "connected" : "not reachable") at \(link.url.absoluteString)"
        runtimeStatus.textColor = link.connected ? .labelColor : .systemOrange
        scanButton.isHidden = paired
        picker.isHidden = paired
        connectButton.isHidden = !paired
        connectButton.title = disconnected ? "Connect" : "Disconnect"
        pairButton.title = paired ? "Unpair" : "Pair"
        pairButton.isEnabled = paired || devices.indices.contains(picker.indexOfSelectedItem)
        captureButton.isEnabled = glasses.ready
        autoBox.state = capture.auto ? .on : .off
        warmBox.state = capture.keepWarm ? .on : .off
        sizePicker.selectItem(at: Self.sizes.firstIndex { $0.0 == capture.size } ?? 1)
    }

    private func say(_ message: String) {
        NSLog("%@", message)
        log.stringValue = message
    }

    private func show(_ captured: CaptureResult) {
        result.stringValue = captured.summary
        result.textColor = captured.error != nil ? .systemRed : captured.target != nil ? .systemGreen : .labelColor
        if let data = capture.lastPhoto { preview.image = NSImage(data: data) }
    }

    // MARK: - Glasses

    @objc private func scan() {
        do {
            scanSession?.stop()
            scanSession = try sdk.scan(model: .mentraLive, timeout: 10) { [weak self] devices in
                guard let self else { return }
                self.devices = devices
                picker.removeAllItems()
                picker.addItems(withTitles: devices.map { device in device.pairingCode.map { "\(device.name)  [\($0)]" } ?? device.name })
                refresh()
            } onComplete: { [weak self] _ in
                self?.scanSession = nil
                self?.say("Scan complete")
            }
            say("Scanning...")
        } catch { say(error.localizedDescription) }
    }

    @objc private func connectOrDisconnect() {
        if sdk.glasses.connection != .disconnected {
            wantConnection = false
            sdk.disconnect()
        } else {
            reconnect(named: nil)
        }
    }

    @objc private func pairOrUnpair() {
        if paired {
            wantConnection = false
            UserDefaults.standard.removeObject(forKey: Self.glassesKey)
            Task { @MainActor in
                do { try await self.sdk.unpair() } catch { self.say(error.localizedDescription) }
                self.say("Unpaired")
                self.refresh()
            }
            return
        }
        guard devices.indices.contains(picker.indexOfSelectedItem) else { return }
        let device = devices[picker.indexOfSelectedItem]
        scanSession?.stop()
        scanSession = nil
        devices = []
        picker.removeAllItems()
        connect(to: device)
    }

    private func connect(to device: Device) {
        wantConnection = true
        do {
            try sdk.connect(to: device)
            UserDefaults.standard.set(device.name, forKey: Self.glassesKey)
            say("Connecting to \(device.name)...")
        } catch { say("Connect failed: \(error.localizedDescription)") }
        refresh()
    }

    /// Finds glasses by Bluetooth name and connects. It never picks glasses on its own:
    /// other teams' glasses may be in the room.
    @discardableResult
    private func reconnect(named requested: String?) -> (Int, [String: Any]) {
        guard sdk.glasses.connection == .disconnected else { return (200, status()) }
        guard let name = requested ?? knownGlasses else {
            return (503, ["error": "no known glasses; use Scan and Pair in the window, or POST /connect?name=Mentra_Live_XXXX"])
        }
        wantConnection = true
        do {
            reconnectScan?.stop()
            reconnectScan = try sdk.scan(model: .mentraLive, timeout: 6) { [weak self] devices in
                guard let self, let device = devices.first(where: { $0.name == name }) else { return }
                self.reconnectScan?.stop()
                self.reconnectScan = nil
                self.connect(to: device)
            } onComplete: { [weak self] _ in
                self?.reconnectScan = nil
            }
            return (200, ["connecting": name])
        } catch {
            return (500, ["error": "\(error)"])
        }
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didUpdateGlasses _: GlassesRuntimeState) {
        capture.runLoops()
        refresh()
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didChangeDefaultDevice _: Device?) {
        refresh()
    }

    func mentraBluetoothSDK(_: MentraBluetoothSDK, didReceive event: BluetoothEvent) {
        // The button on the glasses is the hands-free way to lock what the wearer is looking at.
        if case let .buttonPress(press) = event, press.pressType != "long" {
            Task { @MainActor in _ = await self.capture.capture(trigger: "button") }
        }
    }

    // MARK: - Controls

    @objc private func captureNow() {
        result.stringValue = "Capturing..."
        result.textColor = .labelColor
        Task { @MainActor in _ = await self.capture.capture(trigger: "window") }
    }

    @objc private func toggleAuto() {
        capture.auto = autoBox.state == .on
    }

    @objc private func pickSize() {
        capture.size = Self.sizes[max(0, sizePicker.indexOfSelectedItem)].0
    }

    @objc private func toggleWarm() {
        capture.keepWarm = warmBox.state == .on
    }

    func controlTextDidEndEditing(_: Notification) {
        let text = runtimeAddress.stringValue
        if !link.setAddress(text.isEmpty ? "127.0.0.1:8765" : text) { say("Not a usable Mac runtime address: \(text)") }
        refresh()
    }

    // MARK: - Control endpoint

    private func status() -> [String: Any] {
        var body = capture.status
        body["connection"] = sdk.glasses.connection.rawValue
        body["ready"] = sdk.glasses.ready
        body["glasses"] = sdk.glasses.device?.bluetoothName ?? knownGlasses ?? NSNull()
        body["battery"] = sdk.glasses.battery?.level ?? NSNull()
        body["software"] = sdk.glasses.device?.appVersion ?? NSNull()
        body["runtime"] = ["url": link.url.absoluteString, "connected": link.connected] as [String: Any]
        return body
    }

    private func route(_ request: HTTPRequest) async -> (Int, Any) {
        func flag() -> Bool? {
            ["1": true, "true": true, "on": true, "0": false, "false": false, "off": false][request.query["on"] ?? ""]
        }
        switch (request.method, request.path) {
        case ("GET", "/status"):
            return (200, status())
        case ("POST", "/capture"):
            if let raw = request.query["size"] {
                guard let size = PhotoSize(rawValue: raw) else { return (400, ["error": "size is low, medium, high or max"]) }
                capture.size = size
            }
            if let raw = request.query["compress"] {
                guard let compress = PhotoCompression(rawValue: raw) else { return (400, ["error": "compress is none, low, medium or high"]) }
                capture.compress = compress
            }
            refresh()
            let captured = await capture.capture(trigger: "http")
            return (captured.error == nil ? 200 : 503, captured.json)
        case ("GET", "/photo"):
            guard let photo = capture.lastPhoto else { return (404, ["error": "no photo yet"]) }
            return (200, photo)
        case ("POST", "/connect"):
            let (code, body) = reconnect(named: request.query["name"])
            return (code, body)
        case ("POST", "/auto"):
            guard let on = flag() else { return (400, ["error": "use /auto?on=1 or /auto?on=0"]) }
            capture.auto = on
            refresh()
            return (200, status())
        case ("POST", "/warm"):
            guard let on = flag() else { return (400, ["error": "use /warm?on=1 or /warm?on=0"]) }
            capture.keepWarm = on
            refresh()
            return (200, status())
        case ("POST", "/lock"):
            // Manual recovery path: lock a target without a photo.
            guard let target = request.query["target"], TargetMarker.targets.values.contains(target) else {
                return (400, ["error": "target is one of \(TargetMarker.targets.values.sorted().joined(separator: ", "))"])
            }
            let sent = link.publish(target: target)
            say("Target \(target) locked by hand\(sent ? "" : " (Mac runtime not connected; will send on reconnect)")")
            return (200, ["target": target, "sent": sent])
        case ("POST", "/runtime"):
            guard let address = request.query["address"], link.setAddress(address) else {
                return (400, ["error": "use /runtime?address=host[:port]"])
            }
            runtimeAddress.stringValue = address
            refresh()
            return (200, status())
        default:
            return (404, ["error": "not found"])
        }
    }

    func applicationWillTerminate(_: Notification) {
        retryTimer?.invalidate()
        server.stop()
        link.stop()
        sdk.invalidate()
    }

    func applicationShouldTerminateAfterLastWindowClosed(_: NSApplication) -> Bool {
        true
    }
}
