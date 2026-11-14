import Foundation

@MainActor
final class MacWebSocketClient: MacBridge {
    let incoming: AsyncStream<WireMessage>
    let connectionStates: AsyncStream<MacBridgeConnectionState>

    private var incomingContinuation: AsyncStream<WireMessage>.Continuation?
    private var stateContinuation: AsyncStream<MacBridgeConnectionState>.Continuation?
    private var socket: URLSessionWebSocketTask?
    private var receiveTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    private var endpoint: URL?
    private var shouldReconnect = false
    private var reconnectAttempt = 0

    init() {
        var incomingContinuation: AsyncStream<WireMessage>.Continuation?
        incoming = AsyncStream { incomingContinuation = $0 }
        self.incomingContinuation = incomingContinuation

        var stateContinuation: AsyncStream<MacBridgeConnectionState>.Continuation?
        connectionStates = AsyncStream { stateContinuation = $0 }
        self.stateContinuation = stateContinuation
        stateContinuation?.yield(.disconnected)
    }

    func connect(to url: URL) async throws {
        guard url.scheme == "ws" || url.scheme == "wss", url.host != nil else {
            throw MacBridgeError.invalidURL
        }

        reconnectTask?.cancel()
        reconnectTask = nil
        endpoint = url
        shouldReconnect = true
        reconnectAttempt = 0
        startConnection(to: url, state: .connecting)
    }

    func send(_ message: WireMessage) async throws {
        guard let socket else { throw MacBridgeError.disconnected }
        let data = try JSONEncoder().encode(message)
        let text = String(decoding: data, as: UTF8.self)
        try await socket.send(.string(text))
    }

    func disconnect() async {
        shouldReconnect = false
        endpoint = nil
        reconnectTask?.cancel()
        reconnectTask = nil
        receiveTask?.cancel()
        receiveTask = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        stateContinuation?.yield(.disconnected)
    }

    private func startConnection(to url: URL, state: MacBridgeConnectionState) {
        receiveTask?.cancel()
        socket?.cancel(with: .goingAway, reason: nil)

        stateContinuation?.yield(state)
        let socket = URLSession.shared.webSocketTask(with: url)
        self.socket = socket
        socket.resume()

        receiveTask = Task { [weak self, weak socket] in
            guard let self, let socket else { return }
            await self.receiveLoop(socket)
        }
    }

    private func receiveLoop(_ activeSocket: URLSessionWebSocketTask) async {
        do {
            while !Task.isCancelled {
                let frame = try await activeSocket.receive()
                guard activeSocket === socket else { return }

                let data: Data
                switch frame {
                case .string(let text):
                    data = Data(text.utf8)
                case .data(let value):
                    data = value
                @unknown default:
                    continue
                }

                let message = try JSONDecoder().decode(WireMessage.self, from: data)
                reconnectAttempt = 0
                stateContinuation?.yield(.connected)
                incomingContinuation?.yield(message)
            }
        } catch is CancellationError {
            return
        } catch {
            guard activeSocket === socket else { return }
            socket = nil
            stateContinuation?.yield(.failed(error.localizedDescription))
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        guard shouldReconnect, let endpoint else { return }

        reconnectTask?.cancel()
        reconnectAttempt += 1
        let attempt = reconnectAttempt
        let delaySeconds = min(pow(2.0, Double(attempt - 1)), 5.0)
        stateContinuation?.yield(.reconnecting(attempt: attempt))

        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delaySeconds * 1_000_000_000))
            guard !Task.isCancelled, let self, self.shouldReconnect else { return }
            self.startConnection(
                to: endpoint,
                state: .reconnecting(attempt: attempt)
            )
        }
    }
}
