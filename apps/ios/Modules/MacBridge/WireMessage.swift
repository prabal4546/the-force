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
}

protocol MacBridge {
    var incoming: AsyncStream<WireMessage> { get }
    func connect() async throws
    func send(_ message: WireMessage) async throws
    func disconnect() async
}
