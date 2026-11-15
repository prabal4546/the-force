import Foundation

/// The one message this bridge publishes to the Mac runtime (shared/protocol, version 1).
public enum Wire {
    public static func targetDetected(_ target: String, id: String = UUID().uuidString) -> String {
        let message: [String: Any] = ["version": 1, "id": id, "type": "target.detected", "target": target, "confidence": 1]
        let data = try! JSONSerialization.data(withJSONObject: message, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    /// Accepts "192.168.8.10", "host:8765", "ws://host:8765" or an http(s) address.
    public static func runtimeURL(_ address: String) -> URL? {
        let trimmed = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let candidate = trimmed.contains("://") ? trimmed : "ws://\(trimmed)"
        guard var parts = URLComponents(string: candidate), let host = parts.host, !host.isEmpty else { return nil }
        switch parts.scheme?.lowercased() {
        case "ws", "http": parts.scheme = "ws"
        case "wss", "https": parts.scheme = "wss"
        default: return nil
        }
        if parts.port == nil { parts.port = 8765 }
        parts.path = "/"
        parts.query = nil
        parts.fragment = nil
        return parts.url
    }
}

/// A minimal HTTP/1.1 request, enough for the loopback control endpoint.
public struct HTTPRequest {
    public let method: String
    public let path: String
    public let query: [String: String]
    public let body: Data

    /// Nil until the buffer holds the full head and body.
    public init?(_ buffer: Data) {
        guard let headEnd = buffer.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buffer[..<headEnd.lowerBound], encoding: .utf8) else { return nil }
        let lines = head.components(separatedBy: "\r\n")
        let parts = lines[0].split(separator: " ")
        guard parts.count >= 2 else { return nil }
        var length = 0
        for line in lines.dropFirst() {
            let pair = line.split(separator: ":", maxSplits: 1)
            if pair.count == 2, pair[0].lowercased() == "content-length" {
                length = Int(pair[1].trimmingCharacters(in: .whitespaces)) ?? 0
            }
        }
        let bodyStart = headEnd.upperBound
        guard length >= 0, buffer.count - bodyStart >= length else { return nil }
        method = String(parts[0]).uppercased()
        let target = parts[1].split(separator: "?", maxSplits: 1)
        path = String(target.first ?? "")
        var query: [String: String] = [:]
        if target.count == 2 {
            for pair in target[1].split(separator: "&") {
                let item = pair.split(separator: "=", maxSplits: 1)
                query[String(item[0])] = item.count == 2 ? String(item[1]).removingPercentEncoding ?? String(item[1]) : ""
            }
        }
        self.query = query
        body = buffer.subdata(in: bodyStart ..< bodyStart + length)
    }
}
