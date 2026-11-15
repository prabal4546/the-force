import Foundation
import XCTest
@testable import BodyOS

final class AgentMemoryClientTests: XCTestCase {
    func testMemoryAndPhotoUseTheSessionToken() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer {
            MemoryURLProtocol.handler = nil
            session.invalidateAndCancel()
        }

        MemoryURLProtocol.handler = { request in
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer test-token")
            guard let url = request.url else { throw AgentMemoryClientError.invalidResponse }
            switch url.path {
            case "/v1/agent/memory":
                XCTAssertEqual(URLComponents(url: url, resolvingAgainstBaseURL: false)?
                    .queryItems?.first?.value, "vexo-76")
                return (
                    HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                    Data("""
                    {"facts":["Remember my name is Alex"],"recent_turns":[{
                      "turn_id":"turn-1","image_artifact_id":"photo-1",
                      "understanding":"A desk","command":"What is here?",
                      "tool":"answer","answer":"A desk","created_at":"2026-11-14T12:00:00Z"
                    }]}
                    """.utf8)
                )
            case "/v1/artifacts/photo-1":
                return (
                    HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!,
                    Data([0xFF, 0xD8, 0xFF])
                )
            default:
                throw AgentMemoryClientError.invalidResponse
            }
        }

        let client = AgentMemoryClient(
            baseURL: URL(string: "http://127.0.0.1:8000")!,
            token: "test-token",
            session: session
        )
        let snapshot = try await client.memory(for: "vexo-76")
        XCTAssertEqual(snapshot.facts, ["Remember my name is Alex"])
        XCTAssertEqual(snapshot.recentTurns.first?.command, "What is here?")
        XCTAssertEqual(snapshot.recentTurns.first?.imageArtifactID, "photo-1")
        let photo = try await client.photo(for: "photo-1")
        XCTAssertEqual(photo, Data([0xFF, 0xD8, 0xFF]))
    }

    func testUnauthorizedMemoryReportsTheHTTPStatus() async throws {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.protocolClasses = [MemoryURLProtocol.self]
        let session = URLSession(configuration: configuration)
        defer {
            MemoryURLProtocol.handler = nil
            session.invalidateAndCancel()
        }
        MemoryURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: 401, httpVersion: nil, headerFields: nil)!,
                Data()
            )
        }
        let client = AgentMemoryClient(
            baseURL: URL(string: "http://127.0.0.1:8000")!,
            token: "",
            session: session
        )
        do {
            _ = try await client.memory(for: "vexo-76")
            XCTFail("Expected HTTP 401")
        } catch AgentMemoryClientError.httpStatus(let status) {
            XCTAssertEqual(status, 401)
        }
    }
}

private final class MemoryURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        do {
            guard let handler = Self.handler else { throw AgentMemoryClientError.invalidResponse }
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}
