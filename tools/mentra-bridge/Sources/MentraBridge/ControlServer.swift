import Foundation
import MentraBridgeCore
import Network

/// Local control endpoint, loopback only (127.0.0.1:8766; the Mac runtime owns 8765).
///
///   POST /capture[?size=low|medium|high][&compress=none|low|medium|high]
///                                          one photo -> marker -> target.detected; answers with the result
///   GET  /status                           glasses, Mac runtime link, settings, last capture
///   GET  /photo                            the last photo (JPEG)
///   POST /connect[?name=Mentra_Live_XXXX]  reconnect to the known glasses, or connect to the named ones
///   POST /auto?on=1|0                      continuous capture
///   POST /warm?on=1|0                      keep the camera warm between photos
///   POST /lock?target=mac|externalDisplay|gimbal|personRed|personBlue   lock a target by hand
///   POST /runtime?address=host[:port]      where the Mac runtime is
@MainActor
final class ControlServer {
    static let port: UInt16 = 8766

    /// Answers a request with a status code and either JSON or raw JPEG bytes.
    var route: ((HTTPRequest) async -> (Int, Any))?
    var onLog: ((String) -> Void)?
    private var listener: NWListener?

    func start() {
        do {
            let parameters = NWParameters.tcp
            parameters.allowLocalEndpointReuse = true
            parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: NWEndpoint.Port(rawValue: Self.port)!)
            let listener = try NWListener(using: parameters)
            listener.newConnectionHandler = { [weak self] connection in
                Task { @MainActor in
                    connection.start(queue: .main)
                    self?.receive(connection, buffer: Data())
                }
            }
            listener.stateUpdateHandler = { [weak self] state in
                Task { @MainActor in
                    if case let .failed(error) = state { self?.onLog?("Control endpoint failed: \(error)") }
                }
            }
            listener.start(queue: .main)
            self.listener = listener
        } catch {
            onLog?("Control endpoint failed to start: \(error)")
        }
    }

    func stop() {
        listener?.cancel()
        listener = nil
    }

    private func receive(_ connection: NWConnection, buffer: Data) {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            Task { @MainActor in
                guard let self else { return connection.cancel() }
                var buffer = buffer
                if let data { buffer.append(data) }
                if let request = HTTPRequest(buffer) {
                    let (status, body) = await self.route?(request) ?? (404, ["error": "not found"])
                    self.respond(connection, status: status, body: body)
                } else if isComplete || error != nil || buffer.count > 1_000_000 {
                    connection.cancel()
                } else {
                    self.receive(connection, buffer: buffer)
                }
            }
        }
    }

    private func respond(_ connection: NWConnection, status: Int, body: Any) {
        let payload: Data
        let type: String
        if let jpeg = body as? Data {
            payload = jpeg
            type = "image/jpeg"
        } else {
            payload = (try? JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])) ?? Data("{}".utf8)
            type = "application/json"
        }
        let reason = [200: "OK", 400: "Bad Request", 404: "Not Found", 500: "Internal Server Error", 503: "Service Unavailable"][status] ?? "OK"
        var response = Data("HTTP/1.1 \(status) \(reason)\r\nContent-Type: \(type)\r\nContent-Length: \(payload.count)\r\nConnection: close\r\n\r\n".utf8)
        response.append(payload)
        connection.send(content: response, completion: .contentProcessed { _ in connection.cancel() })
    }
}
