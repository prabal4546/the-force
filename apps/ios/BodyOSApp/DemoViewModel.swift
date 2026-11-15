import Combine
import Foundation

@MainActor
final class DemoViewModel: ObservableObject {
    @Published private(set) var state: DemoState = .idle
    @Published var selectedTarget: TargetID = .mac
    @Published var macHost = UserDefaults.standard.string(forKey: "bodyos.macHost") ?? "127.0.0.1"
    @Published private(set) var macConnection: MacBridgeConnectionState = .disconnected
    @Published private(set) var eventLog: [String] = []
    @Published private(set) var lastError: String?

    let mentraStatus = "Miniapp lock"
    let gimbalStatus = "Mock"

    private let macBridge: any MacBridge
    private var coordinator = DemoCoordinator()
    private var incomingTask: Task<Void, Never>?
    private var connectionTask: Task<Void, Never>?
    private var seenMessageIDs = Set<String>()
    private var seenMessageOrder: [String] = []
    private var pendingRequestIDs = Set<String>()

    init(macBridge: (any MacBridge)? = nil) {
        self.macBridge = macBridge ?? MacWebSocketClient()
        observeMacBridge()
    }

    func connectMac() {
        guard let url = macWebSocketURL else {
            report("Invalid Mac address")
            return
        }

        UserDefaults.standard.set(macHost, forKey: "bodyos.macHost")
        lastError = nil
        append("Connecting to \(url.absoluteString)")

        Task {
            do {
                try await macBridge.connect(to: url)
            } catch {
                report(error.localizedDescription)
            }
        }
    }

    func disconnectMac() {
        Task { await macBridge.disconnect() }
    }

    func send(_ gesture: GestureName) {
        Task {
            await process(.gesture(gesture), note: "Manual gesture: \(gesture.rawValue)")
        }
    }

    func reset() {
        coordinator = DemoCoordinator()
        state = coordinator.state
        lastError = nil
        pendingRequestIDs.removeAll()
        eventLog.removeAll()
        append("Coordinator reset")
    }

    private var macWebSocketURL: URL? {
        let trimmed = macHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }

        let candidate = trimmed.contains("://") ? trimmed : "ws://\(trimmed)"
        guard var components = URLComponents(string: candidate) else { return nil }
        if components.port == nil { components.port = 8765 }
        guard components.scheme == "ws" || components.scheme == "wss" else { return nil }
        return components.url
    }

    private func observeMacBridge() {
        incomingTask = Task { [weak self, macBridge] in
            for await message in macBridge.incoming {
                guard let self else { return }
                await self.receive(message)
            }
        }

        connectionTask = Task { [weak self, macBridge] in
            for await connection in macBridge.connectionStates {
                guard let self else { return }
                self.macConnection = connection
                self.append("Mac: \(connection.description)")
                if !connection.isConnected {
                    self.pendingRequestIDs.removeAll()
                }
            }
        }
    }

    private func receive(_ message: WireMessage) async {
        guard remember(message.id) else {
            append("Ignored duplicate: \(message.type)")
            return
        }

        if let replyTo = message.replyTo {
            guard pendingRequestIDs.remove(replyTo) != nil else {
                append("Ignored stale reply: \(message.type)")
                return
            }
        }

        switch message.type {
        case "hello":
            append("Mac runtime ready")

        case "gesture.detected":
            guard
                let rawGesture = message.gesture,
                let gesture = GestureName(rawValue: rawGesture)
            else {
                report("Mac sent an invalid gesture")
                return
            }

            let confidence = message.confidence ?? 0
            guard confidence >= 0.65 else {
                append("Ignored low-confidence \(rawGesture): \(confidence)")
                return
            }
            await process(
                .gesture(gesture),
                note: "Vexo: \(rawGesture) (\(Int(confidence * 100))%)"
            )

        case "target.detected":
            guard
                let rawTarget = message.target,
                let target = TargetID(rawValue: rawTarget)
            else {
                report("Mentra sent an invalid target")
                return
            }
            selectedTarget = target
            append("Mentra locked: \(target.label)")

        case "window.captured":
            guard let token = message.token, !token.isEmpty else {
                await fail("Mac returned an empty window token")
                return
            }
            await process(.windowCaptured(token: token), note: "Window captured")

        case "window.moved":
            await process(
                .windowMoveFinished(success: message.success == true),
                note: message.success == true ? "Window moved" : "Window move failed"
            )

        case "error":
            await fail(message.message ?? message.code ?? "Mac runtime error")

        case "pong":
            append("Mac heartbeat acknowledged")

        default:
            append("Ignored unsupported message: \(message.type)")
        }
    }

    private func process(_ event: ProductEvent, note: String) async {
        append(note)
        let commands = coordinator.handle(event)
        state = coordinator.state
        await execute(commands)
    }

    private func execute(_ commands: [ProductCommand]) async {
        for command in commands {
            append("Command: \(command.description)")

            switch command {
            case .requestTargetCapture:
                // Mentra owner replaces this with a real TargetSource call.
                await process(
                    .targetDetected(selectedTarget),
                    note: "Mock Mentra: \(selectedTarget.label)"
                )

            case .captureFrontmostWindow:
                await sendToMac(WireMessage(type: "window.capture"), expectsReply: true)

            case .moveWindow(let token):
                await sendToMac(
                    WireMessage(
                        type: "window.move",
                        token: token,
                        destination: TargetID.externalDisplay.rawValue
                    ),
                    expectsReply: true
                )

            case .trackPerson(let person):
                // Gimbal owner replaces this acknowledgement with DockKitController.
                try? await Task.sleep(nanoseconds: 250_000_000)
                await process(
                    .trackingChanged(person: person, state: .tracking),
                    note: "Mock DockKit: tracking \(person.label)"
                )

            case .setVexoLED(let color):
                guard macConnection.isConnected else {
                    append("Skipped Vexo LED while Mac is disconnected")
                    continue
                }
                await sendToMac(
                    WireMessage(type: "vexo.led", color: color.rawValue),
                    expectsReply: false
                )
            }
        }
    }

    private func sendToMac(_ message: WireMessage, expectsReply: Bool) async {
        guard macConnection.isConnected else {
            await fail("Mac runtime is disconnected")
            return
        }

        if expectsReply { pendingRequestIDs.insert(message.id) }
        do {
            try await macBridge.send(message)
        } catch {
            pendingRequestIDs.remove(message.id)
            await fail(error.localizedDescription)
        }
    }

    private func fail(_ message: String) async {
        lastError = message
        append("Error: \(message)")
        let commands = coordinator.handle(.failure(message))
        state = coordinator.state
        await execute(commands)
    }

    private func report(_ message: String) {
        lastError = message
        append("Error: \(message)")
    }

    private func remember(_ id: String) -> Bool {
        let inserted = seenMessageIDs.insert(id).inserted
        guard inserted else { return false }

        seenMessageOrder.append(id)
        if seenMessageOrder.count > 256 {
            let expired = seenMessageOrder.removeFirst()
            seenMessageIDs.remove(expired)
        }
        return true
    }

    private func append(_ text: String) {
        eventLog.insert(text, at: 0)
        eventLog = Array(eventLog.prefix(30))
    }
}
