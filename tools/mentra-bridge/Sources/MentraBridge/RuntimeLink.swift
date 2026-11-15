import Foundation
import MentraBridgeCore

/// WebSocket client to the Mac runtime (`ws://127.0.0.1:8765`). Publishes `target.detected`
/// and keeps reconnecting, so the runtime and this bridge can start in either order.
@MainActor
final class RuntimeLink {
    static let addressKey = "runtimeAddress"

    private(set) var url: URL
    private(set) var connected = false
    /// The last target handed to `publish`; sent again after a reconnect because a restarted runtime forgets it.
    private(set) var target: String?
    var onChange: (() -> Void)?
    var onLog: ((String) -> Void)?

    private var task: URLSessionWebSocketTask?
    private var generation = 0

    init() {
        let saved = UserDefaults.standard.string(forKey: Self.addressKey) ?? ""
        url = Wire.runtimeURL(saved) ?? URL(string: "ws://127.0.0.1:8765/")!
    }

    func start() {
        open()
    }

    func stop() {
        generation += 1
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        connected = false
    }

    /// - Returns: false when the address is not usable; the old one stays.
    @discardableResult
    func setAddress(_ address: String) -> Bool {
        guard let url = Wire.runtimeURL(address) else { return false }
        UserDefaults.standard.set(address, forKey: Self.addressKey)
        guard url != self.url else { return true }
        self.url = url
        stop()
        onChange?()
        open()
        return true
    }

    /// - Returns: true when the message went out now; otherwise it goes out when the link is back.
    @discardableResult
    func publish(target: String) -> Bool {
        self.target = target
        guard connected, let task else { return false }
        task.send(.string(Wire.targetDetected(target))) { _ in }
        return true
    }

    private func open() {
        generation += 1
        let current = generation
        let task = URLSession.shared.webSocketTask(with: url)
        self.task = task
        task.resume()
        receive(task, current)
    }

    private func receive(_ task: URLSessionWebSocketTask, _ current: Int) {
        task.receive { [weak self] result in
            Task { @MainActor in
                guard let self, self.generation == current else { return }
                switch result {
                case .success:
                    // The runtime greets every client with "hello", so the first frame means the link is up.
                    if !self.connected {
                        self.connected = true
                        self.onLog?("Mac runtime connected at \(self.url.absoluteString)")
                        if let target = self.target { self.publish(target: target) }
                        self.onChange?()
                    }
                    self.receive(task, current)
                case .failure:
                    if self.connected { self.onLog?("Mac runtime link lost; retrying") }
                    self.connected = false
                    self.task = nil
                    self.onChange?()
                    try? await Task.sleep(nanoseconds: 2_000_000_000)
                    if self.generation == current { self.open() }
                }
            }
        }
    }
}
