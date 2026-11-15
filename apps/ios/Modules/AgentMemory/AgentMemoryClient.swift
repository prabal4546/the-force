import Foundation

struct AgentMemorySnapshot: Decodable {
    let facts: [String]
    let recentTurns: [AgentMemoryTurn]

    enum CodingKeys: String, CodingKey {
        case facts
        case recentTurns = "recent_turns"
    }
}

struct AgentMemoryTurn: Decodable, Identifiable {
    let turnID: String
    let imageArtifactID: String?
    let understanding: String?
    let command: String
    let tool: String?
    let answer: String?
    let createdAt: String

    var id: String { turnID }

    enum CodingKeys: String, CodingKey {
        case turnID = "turn_id"
        case imageArtifactID = "image_artifact_id"
        case understanding
        case command
        case tool
        case answer
        case createdAt = "created_at"
    }
}

enum AgentMemoryClientError: LocalizedError {
    case invalidResponse
    case httpStatus(Int)

    var errorDescription: String? {
        switch self {
        case .invalidResponse:
            return "The device API returned an invalid response."
        case .httpStatus(let status):
            return "The device API returned HTTP \(status)."
        }
    }
}

struct AgentMemoryClient {
    let baseURL: URL
    let token: String
    var session: URLSession = .shared

    func memory(for deviceID: String) async throws -> AgentMemorySnapshot {
        var components = URLComponents(
            url: baseURL.appendingPathComponent("v1/agent/memory"),
            resolvingAgainstBaseURL: false
        )
        components?.queryItems = [URLQueryItem(name: "device_id", value: deviceID)]
        guard let url = components?.url else { throw AgentMemoryClientError.invalidResponse }
        return try JSONDecoder().decode(AgentMemorySnapshot.self, from: await get(url))
    }

    func photo(for artifactID: String) async throws -> Data {
        let url = baseURL.appendingPathComponent("v1/artifacts")
            .appendingPathComponent(artifactID)
        return try await get(url)
    }

    private func get(_ url: URL) async throws -> Data {
        var request = URLRequest(url: url)
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        let credential = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if !credential.isEmpty {
            request.setValue("Bearer \(credential)", forHTTPHeaderField: "Authorization")
        }
        let (data, response) = try await session.data(for: request)
        guard let response = response as? HTTPURLResponse else {
            throw AgentMemoryClientError.invalidResponse
        }
        guard (200..<300).contains(response.statusCode) else {
            throw AgentMemoryClientError.httpStatus(response.statusCode)
        }
        return data
    }
}
