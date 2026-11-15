import Foundation
import MentraBridgeCore

/// Hands each photo to the device API (`POST /v1/glasses/photos`), where the agent
/// reads the newest one when a spoken command arrives. Optional: without the API
/// running, uploads fail fast and target lock carries on.
@MainActor
final class ApiUpload {
    static let addressKey = "apiAddress"
    static let tokenKey = "apiToken"
    static let deviceId = "glasses-1"

    private(set) var base: URL
    var token: String? { UserDefaults.standard.string(forKey: Self.tokenKey) }
    private(set) var lastError: String?
    private(set) var uploads = 0
    var onLog: ((String) -> Void)?

    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 4
        return URLSession(configuration: configuration)
    }()

    init() {
        base = URL(string: UserDefaults.standard.string(forKey: Self.addressKey) ?? "") ?? URL(string: "http://127.0.0.1:8000")!
    }

    @discardableResult
    func setAddress(_ address: String, token: String?) -> Bool {
        let text = address.contains("://") ? address : "http://\(address)"
        guard let url = URL(string: text), url.host != nil else { return false }
        base = url
        UserDefaults.standard.set(text, forKey: Self.addressKey)
        if let token { UserDefaults.standard.set(token.isEmpty ? nil : token, forKey: Self.tokenKey) }
        return true
    }

    var status: [String: Any] {
        ["url": base.absoluteString, "uploads": uploads, "lastError": lastError ?? NSNull()]
    }

    /// - Returns: true when the API stored the photo.
    func upload(photo: Data, requestId: String) async -> Bool {
        do {
            var code = try await post(photo: photo, requestId: requestId)
            if code == 404 {
                // The API forgets devices when it restarts; sign the glasses in and try once more.
                try await register()
                code = try await post(photo: photo, requestId: requestId)
            }
            guard (200 ..< 300).contains(code) else { throw URLError(.badServerResponse, userInfo: [NSLocalizedDescriptionKey: "HTTP \(code)"]) }
            if lastError != nil { onLog?("Device API is taking photos again at \(base.absoluteString)") }
            lastError = nil
            uploads += 1
            return true
        } catch {
            let message = error.localizedDescription
            // Say it once, not on every photo, while the API is simply not running.
            if lastError == nil { onLog?("Photo not sent to the device API at \(base.absoluteString): \(message)") }
            lastError = message
            return false
        }
    }

    private func request(_ path: String, query: String? = nil) -> URLRequest {
        var parts = URLComponents(url: base, resolvingAgainstBaseURL: false)!
        parts.path = path
        parts.query = query
        var request = URLRequest(url: parts.url!)
        request.httpMethod = "POST"
        if let token, !token.isEmpty { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func post(photo: Data, requestId: String) async throws -> Int {
        let boundary = "bridge-\(UUID().uuidString)"
        var request = request("/v1/glasses/photos", query: "device_id=\(Self.deviceId)")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        let (_, response) = try await session.upload(for: request, from: Wire.multipartPhoto(photo, requestId: requestId, boundary: boundary))
        return (response as? HTTPURLResponse)?.statusCode ?? 0
    }

    private func register() async throws {
        var request = request("/v1/devices/connect")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        let body = ["device_id": Self.deviceId, "device_type": "glasses", "hardware_status": "connected"]
        _ = try await session.upload(for: request, from: JSONSerialization.data(withJSONObject: body))
    }
}
