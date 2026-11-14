import Foundation

struct WireMessage: Codable, Sendable {
    let version: Int
    let id: String
    var replyTo: String?
    let type: String
    var gesture: String?
    var confidence: Double?
    var target: String?
    var token: String?
    var destination: String?
    var success: Bool?
    var state: String?
    var color: String?
    var code: String?
    var message: String?

    init(
        type: String,
        id: String = UUID().uuidString,
        replyTo: String? = nil,
        gesture: String? = nil,
        confidence: Double? = nil,
        target: String? = nil,
        token: String? = nil,
        destination: String? = nil,
        success: Bool? = nil,
        state: String? = nil,
        color: String? = nil,
        code: String? = nil,
        message: String? = nil
    ) {
        self.version = 1
        self.id = id
        self.replyTo = replyTo
        self.type = type
        self.gesture = gesture
        self.confidence = confidence
        self.target = target
        self.token = token
        self.destination = destination
        self.success = success
        self.state = state
        self.color = color
        self.code = code
        self.message = message
    }
}

enum MacBridgeConnectionState: Equatable, Sendable, CustomStringConvertible {
    case disconnected
    case connecting
    case connected
    case reconnecting(attempt: Int)
    case failed(String)

    var isConnected: Bool {
        if case .connected = self { return true }
        return false
    }

    var description: String {
        switch self {
        case .disconnected: return "Disconnected"
        case .connecting: return "Connecting"
        case .connected: return "Connected"
        case .reconnecting(let attempt): return "Reconnecting (\(attempt))"
        case .failed(let message): return "Failed: \(message)"
        }
    }
}

enum MacBridgeError: LocalizedError {
    case invalidURL
    case disconnected

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Enter a valid ws:// or wss:// Mac address"
        case .disconnected: return "The Mac runtime is not connected"
        }
    }
}

@MainActor
protocol MacBridge: AnyObject {
    var incoming: AsyncStream<WireMessage> { get }
    var connectionStates: AsyncStream<MacBridgeConnectionState> { get }
    func connect(to url: URL) async throws
    func send(_ message: WireMessage) async throws
    func disconnect() async
}
